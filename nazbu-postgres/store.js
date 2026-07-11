'use strict'

/*
 * PostgresStore — a Nazbu store adapter for PostgreSQL.
 *
 * Same contract as the Mongo adapter (see ../nazbu-mongo/bridge.js):
 *   store.onLocalChange(cb)   cb({ ns, id, doc|null, v, by, pol }) for LOCAL writes
 *   store.applyRemote(change) apply a peer's change (LWW or append-only)
 *   store.close()
 *
 * Capture, without touching your tables:
 *   A tiny AFTER trigger on each tracked table writes every row change into a
 *   _nazbu_outbox table and fires NOTIFY. We LISTEN, drain the outbox in order,
 *   and emit one change per row. Your tables are never altered.
 *
 * Echo prevention:
 *   When WE apply a peer's change, we run it inside a transaction that sets
 *   `nazbu.apply = '1'`. The trigger checks that flag and skips — so an applied
 *   change never bounces back out as a local change.
 *
 * Conflicts (per table, from `policies`):
 *   - last-writer-wins (default): newest change wins, ordered by a Lamport
 *     version `v`, tie-broken by node name. State kept in _nazbu_meta.
 *   - append-only: insert-once, deduped by primary key — nothing is overwritten
 *     (use it for ledgers: sales, stock movements, journal entries).
 */

const OUTBOX = '_nazbu_outbox'
const META = '_nazbu_meta'
const CURSOR = '_nazbu_cursor'

const qi = (name) => '"' + String(name).replace(/"/g, '""') + '"'
const jsonScalar = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)

class PostgresStore {
  constructor ({ pool, name, policies = {}, tables = null, exclude = [], schema = 'public' }) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new Error('PostgresStore needs a pg Pool (new Pool({ connectionString }))')
    }
    this.pool = pool
    this.name = name || 'pg-' + process.pid
    this.schema = schema
    this.policies = policies || {}
    this.tablesAllow = tables ? tables.map(String) : null
    this.exclude = new Set((exclude || []).map(String))
    this.clock = 0
    this.cursor = 0
    this.pk = new Map()        // table -> primary-key column
    this._cb = null
    this._listen = null        // dedicated LISTEN client
    this._draining = false
    this._again = false
    this._closed = false
    this._poll = null
  }

  policyFor (ns) {
    const p = this.policies[ns] || this.policies['*'] || 'last-writer-wins'
    return (p === 'append-only' || p === 'ledger') ? 'append-only' : 'last-writer-wins'
  }

  // ── setup ────────────────────────────────────────────────────────────────
  async _ensureInfra () {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${OUTBOX} (
        seq bigserial PRIMARY KEY, ns text, pk text, op text, row jsonb,
        created_at timestamptz DEFAULT now());
      CREATE TABLE IF NOT EXISTS ${META} (
        ns text, pk text, v bigint, by text, PRIMARY KEY (ns, pk));
      CREATE TABLE IF NOT EXISTS ${CURSOR} (id int PRIMARY KEY, seq bigint);
      INSERT INTO ${CURSOR} (id, seq) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

      CREATE OR REPLACE FUNCTION _nazbu_capture() RETURNS trigger AS $fn$
      DECLARE r jsonb; pkval text;
      BEGIN
        IF current_setting('nazbu.apply', true) = '1' THEN RETURN NULL; END IF;
        IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); ELSE r := to_jsonb(NEW); END IF;
        pkval := r ->> TG_ARGV[0];
        INSERT INTO ${OUTBOX} (ns, pk, op, row)
          VALUES (TG_TABLE_NAME, pkval, TG_OP,
                  CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE r END);
        PERFORM pg_notify('nazbu', TG_TABLE_NAME);
        RETURN NULL;
      END; $fn$ LANGUAGE plpgsql;
    `)
    const cur = await this.pool.query(`SELECT seq FROM ${CURSOR} WHERE id = 1`)
    this.cursor = Number(cur.rows[0] ? cur.rows[0].seq : 0)
    const mx = await this.pool.query(`SELECT COALESCE(MAX(v), 0) AS v FROM ${META}`)
    this.clock = Number(mx.rows[0].v)
  }

  async _discoverTables () {
    const res = await this.pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename NOT LIKE '\\_nazbu\\_%'`,
      [this.schema]
    )
    let names = res.rows.map(r => r.tablename)
    if (this.tablesAllow) names = names.filter(n => this.tablesAllow.includes(n))
    names = names.filter(n => !this.exclude.has(n))

    const tracked = []
    for (const t of names) {
      const pk = await this.pool.query(
        `SELECT a.attname AS col
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = $1::regclass AND i.indisprimary`,
        [qi(this.schema) + '.' + qi(t)]
      )
      if (pk.rows.length !== 1) {
        console.warn(`[nazbu-pg] skipping "${t}" — needs a single-column primary key`)
        continue
      }
      this.pk.set(t, pk.rows[0].col)
      tracked.push(t)
    }
    return tracked
  }

  async _installTriggers (tables) {
    for (const t of tables) {
      const rel = qi(this.schema) + '.' + qi(t)
      await this.pool.query(`DROP TRIGGER IF EXISTS _nazbu_t ON ${rel}`)
      await this.pool.query(
        `CREATE TRIGGER _nazbu_t AFTER INSERT OR UPDATE OR DELETE ON ${rel}
         FOR EACH ROW EXECUTE FUNCTION _nazbu_capture('${this.pk.get(t)}')`
      )
    }
  }

  async start () {
    await this._ensureInfra()
    const tables = await this._discoverTables()
    await this._installTriggers(tables)

    // Dedicated connection for LISTEN — stays checked out until close().
    this._listen = await this.pool.connect()
    this._listen.on('notification', () => this._drain())
    this._listen.on('error', () => {})
    await this._listen.query('LISTEN nazbu')

    // Safety-net poll in case a NOTIFY is ever missed.
    this._poll = setInterval(() => this._drain(), 3000)
    if (this._poll.unref) this._poll.unref()

    console.log(`[nazbu-pg] tracking ${tables.length} table(s): ${tables.join(', ') || '(none)'}`)
    // Catch up on anything already in the outbox.
    await this._drain()
    return this
  }

  onLocalChange (cb) { this._cb = cb; this._drain() }

  // ── local → peers ─────────────────────────────────────────────────────────
  async _drain () {
    if (!this._cb || this._closed) return
    if (this._draining) { this._again = true; return }
    this._draining = true
    try {
      for (;;) {
        const { rows } = await this.pool.query(
          `SELECT seq, ns, pk, op, row FROM ${OUTBOX} WHERE seq > $1 ORDER BY seq LIMIT 200`,
          [this.cursor]
        )
        if (!rows.length) break
        for (const r of rows) {
          const v = ++this.clock
          // Record our own version so later LWW comparisons are consistent.
          await this.pool.query(
            `INSERT INTO ${META} (ns, pk, v, by) VALUES ($1,$2,$3,$4)
             ON CONFLICT (ns, pk) DO UPDATE SET v = EXCLUDED.v, by = EXCLUDED.by`,
            [r.ns, r.pk, v, this.name]
          )
          this._cb({
            ns: r.ns,
            id: r.pk,
            doc: r.op === 'DELETE' ? null : r.row,
            v,
            by: this.name,
            pol: this.policyFor(r.ns)
          })
          this.cursor = Number(r.seq)
        }
        await this.pool.query(`UPDATE ${CURSOR} SET seq = $1 WHERE id = 1`, [this.cursor])
        await this.pool.query(`DELETE FROM ${OUTBOX} WHERE seq <= $1`, [this.cursor])
      }
    } catch (e) {
      if (!this._closed) console.error('[nazbu-pg] drain error:', e.message)
    } finally {
      this._draining = false
      if (this._again) { this._again = false; this._drain() }
    }
  }

  // ── peers → local ─────────────────────────────────────────────────────────
  async applyRemote (ch) {
    if (this._closed) return false
    const pk = this.pk.get(ch.ns)
    if (!pk) return false // we don't track this table
    // Advance our Lamport clock past what we've seen, so our NEXT local change
    // outranks this one — otherwise a reply edit would look stale and be dropped.
    this.clock = Math.max(this.clock, Number(ch.v) || 0)
    const pol = ch.pol || this.policyFor(ch.ns)

    // Conflict gate.
    if (pol === 'append-only') {
      const seen = await this.pool.query(`SELECT 1 FROM ${META} WHERE ns=$1 AND pk=$2`, [ch.ns, ch.id])
      if (seen.rows.length) return false // insert-once
    } else {
      const m = await this.pool.query(`SELECT v, by FROM ${META} WHERE ns=$1 AND pk=$2`, [ch.ns, ch.id])
      if (m.rows.length) {
        const cv = Number(m.rows[0].v)
        if (cv > ch.v || (cv === ch.v && m.rows[0].by >= ch.by)) return false // stale
      }
    }

    const c = await this.pool.connect()
    try {
      await c.query('BEGIN')
      await c.query("SET LOCAL nazbu.apply = '1'") // trigger will skip → no echo
      const rel = qi(this.schema) + '.' + qi(ch.ns)

      if (ch.doc === null) {
        await c.query(`DELETE FROM ${rel} WHERE ${qi(pk)} = $1`, [ch.id])
      } else {
        const cols = Object.keys(ch.doc)
        const vals = cols.map(k => jsonScalar(ch.doc[k]))
        const ph = cols.map((_, i) => '$' + (i + 1))
        const setList = cols.filter(k => k !== pk).map(k => `${qi(k)} = EXCLUDED.${qi(k)}`)
        const sql = `INSERT INTO ${rel} (${cols.map(qi).join(',')}) VALUES (${ph.join(',')})
                     ON CONFLICT (${qi(pk)}) DO UPDATE SET ${setList.join(',') || `${qi(pk)} = EXCLUDED.${qi(pk)}`}`
        await c.query(sql, vals)
      }

      await c.query(
        `INSERT INTO ${META} (ns, pk, v, by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (ns, pk) DO UPDATE SET v = EXCLUDED.v, by = EXCLUDED.by`,
        [ch.ns, ch.id, ch.v, ch.by]
      )
      await c.query('COMMIT')
      return true
    } catch (e) {
      try { await c.query('ROLLBACK') } catch (_) {}
      if (!this._closed) console.error('[nazbu-pg] apply error on', ch.ns, ch.id, '-', e.message)
      return false
    } finally {
      c.release()
    }
  }

  async close () {
    this._closed = true
    if (this._poll) clearInterval(this._poll)
    try { if (this._listen) { await this._listen.query('UNLISTEN nazbu'); this._listen.release() } } catch (_) {}
  }
}

module.exports = { PostgresStore }
