'use strict'

/*
 * MySqlStore — a Nazbu store adapter for MySQL / MariaDB.
 *
 * Same contract as the other adapters (onLocalChange / applyRemote / close / start).
 *
 * Capture, without touching your tables:
 *   Three AFTER triggers (INSERT/UPDATE/DELETE) per tracked table write every row
 *   change into a _nazbu_outbox table. MySQL has no LISTEN/NOTIFY, so the adapter
 *   POLLS the outbox on a short interval and drains it in order. Your tables are
 *   never altered.
 *
 * Echo prevention:
 *   Remote changes are applied on a dedicated connection where the session flag
 *   `@nazbu_apply = 1`. The triggers check that flag and skip — so an applied
 *   change never bounces back out.
 *
 * Conflicts (per table, from `policies`): last-writer-wins (Lamport `v` in
 * _nazbu_meta) or append-only (insert-once, deduped by primary key).
 */

const OUTBOX = '_nazbu_outbox'
const META = '_nazbu_meta'
const CURSOR = '_nazbu_cursor'

const qi = (n) => '`' + String(n).replace(/`/g, '``') + '`'
const jsonScalar = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)

class MySqlStore {
  constructor ({ pool, name, policies = {}, tables = null, exclude = [], pollMs = 1000 }) {
    if (!pool || typeof pool.getConnection !== 'function') {
      throw new Error('MySqlStore needs a mysql2/promise pool (mysql.createPool(...))')
    }
    this.pool = pool
    this.name = name || 'mysql-' + process.pid
    this.policies = policies || {}
    this.tablesAllow = tables ? tables.map(String) : null
    this.exclude = new Set((exclude || []).map(String))
    this.pollMs = pollMs
    this.clock = 0
    this.cursor = 0
    this.pk = new Map()       // table -> primary-key column
    this.dbName = null
    this._cb = null
    this._applyConn = null    // dedicated connection with @nazbu_apply = 1
    this._poll = null
    this._draining = false
    this._again = false
    this._closed = false
  }

  policyFor (ns) {
    const p = this.policies[ns] || this.policies['*'] || 'last-writer-wins'
    return (p === 'append-only' || p === 'ledger') ? 'append-only' : 'last-writer-wins'
  }

  async _q (sql, args) { const [rows] = await this.pool.query(sql, args); return rows }

  async _ensureInfra () {
    const r = await this._q('SELECT DATABASE() AS db')
    this.dbName = r[0].db
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${OUTBOX} (seq BIGINT AUTO_INCREMENT PRIMARY KEY, ns VARCHAR(191), pk VARCHAR(191), op VARCHAR(10), \`row\` JSON NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`)
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${META} (ns VARCHAR(191), pk VARCHAR(191), v BIGINT, \`by\` VARCHAR(191), PRIMARY KEY (ns, pk))`)
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${CURSOR} (id INT PRIMARY KEY, seq BIGINT)`)
    await this.pool.query(`INSERT IGNORE INTO ${CURSOR} (id, seq) VALUES (1, 0)`)
    const cur = await this._q(`SELECT seq FROM ${CURSOR} WHERE id = 1`)
    this.cursor = Number(cur[0] ? cur[0].seq : 0)
    const mx = await this._q(`SELECT COALESCE(MAX(v), 0) AS v FROM ${META}`)
    this.clock = Number(mx[0].v)
  }

  async _cols (t) {
    const rows = await this._q(
      `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
      [this.dbName, t]
    )
    return rows.map(r => r.c)
  }

  async _pk (t) {
    const rows = await this._q(
      `SELECT column_name AS c FROM information_schema.key_column_usage WHERE table_schema = ? AND table_name = ? AND constraint_name = 'PRIMARY'`,
      [this.dbName, t]
    )
    return rows.map(r => r.c)
  }

  async _discoverTables () {
    const rows = await this._q(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' AND table_name NOT LIKE '\\_nazbu\\_%'`,
      [this.dbName]
    )
    let names = rows.map(r => r.t)
    if (this.tablesAllow) names = names.filter(n => this.tablesAllow.includes(n))
    return names.filter(n => !this.exclude.has(n))
  }

  async _installTriggers (t, cols, pk) {
    const objNew = 'JSON_OBJECT(' + cols.map(c => `'${c}', NEW.${qi(c)}`).join(', ') + ')'
    const trig = (suffix, event, rowExpr, pkRef) =>
      `CREATE TRIGGER ${qi('_nazbu_' + t + '_' + suffix)} AFTER ${event} ON ${qi(t)} FOR EACH ROW\n` +
      `BEGIN\n` +
      `  IF COALESCE(@nazbu_apply, 0) = 0 THEN\n` +
      `    INSERT INTO ${OUTBOX} (ns, pk, op, \`row\`) VALUES ('${t}', CAST(${pkRef} AS CHAR), '${event}', ${rowExpr});\n` +
      `  END IF;\n` +
      `END`
    for (const s of ['ai', 'au', 'ad']) await this.pool.query(`DROP TRIGGER IF EXISTS ${qi('_nazbu_' + t + '_' + s)}`)
    await this.pool.query(trig('ai', 'INSERT', objNew, `NEW.${qi(pk)}`))
    await this.pool.query(trig('au', 'UPDATE', objNew, `NEW.${qi(pk)}`))
    await this.pool.query(trig('ad', 'DELETE', 'NULL', `OLD.${qi(pk)}`))
  }

  async start () {
    await this._ensureInfra()
    const names = await this._discoverTables()
    const tracked = []
    for (const t of names) {
      const pks = await this._pk(t)
      if (pks.length !== 1) { console.warn(`[nazbu-mysql] skipping "${t}" — needs a single-column primary key`); continue }
      const cols = await this._cols(t)
      this.pk.set(t, pks[0])
      await this._installTriggers(t, cols, pks[0])
      tracked.push(t)
    }
    // Dedicated apply connection: its writes are flagged so triggers skip them.
    this._applyConn = await this.pool.getConnection()
    await this._applyConn.query('SET @nazbu_apply = 1')

    this._poll = setInterval(() => this._drain(), this.pollMs)
    if (this._poll.unref) this._poll.unref()

    console.log(`[nazbu-mysql] tracking ${tracked.length} table(s): ${tracked.join(', ') || '(none)'}`)
    await this._drain()
    return this
  }

  onLocalChange (cb) { this._cb = cb; this._drain() }

  async _drain () {
    if (!this._cb || this._closed) return
    if (this._draining) { this._again = true; return }
    this._draining = true
    try {
      for (;;) {
        const rows = await this._q(
          `SELECT seq, ns, pk, op, \`row\` AS r FROM ${OUTBOX} WHERE seq > ? ORDER BY seq LIMIT 200`,
          [this.cursor]
        )
        if (!rows.length) break
        for (const r of rows) {
          const v = ++this.clock
          await this.pool.query(
            `INSERT INTO ${META} (ns, pk, v, \`by\`) VALUES (?,?,?,?)
             ON DUPLICATE KEY UPDATE v = VALUES(v), \`by\` = VALUES(\`by\`)`,
            [r.ns, r.pk, v, this.name]
          )
          const doc = r.op === 'DELETE' ? null : (typeof r.r === 'string' ? JSON.parse(r.r) : r.r)
          this._cb({ ns: r.ns, id: String(r.pk), doc, v, by: this.name, pol: this.policyFor(r.ns) })
          this.cursor = Number(r.seq)
        }
        await this.pool.query(`UPDATE ${CURSOR} SET seq = ? WHERE id = 1`, [this.cursor])
        await this.pool.query(`DELETE FROM ${OUTBOX} WHERE seq <= ?`, [this.cursor])
      }
    } catch (e) {
      if (!this._closed) console.error('[nazbu-mysql] drain error:', e.message)
    } finally {
      this._draining = false
      if (this._again) { this._again = false; this._drain() }
    }
  }

  async applyRemote (ch) {
    if (this._closed) return false
    const pk = this.pk.get(ch.ns)
    if (!pk) return false
    this.clock = Math.max(this.clock, Number(ch.v) || 0)
    const pol = ch.pol || this.policyFor(ch.ns)

    if (pol === 'append-only') {
      const seen = await this._q(`SELECT 1 FROM ${META} WHERE ns = ? AND pk = ? LIMIT 1`, [ch.ns, ch.id])
      if (seen.length) return false
    } else {
      const m = await this._q(`SELECT v, \`by\` AS b FROM ${META} WHERE ns = ? AND pk = ? LIMIT 1`, [ch.ns, ch.id])
      if (m.length) {
        const cv = Number(m[0].v)
        if (cv > ch.v || (cv === ch.v && String(m[0].b) >= ch.by)) return false
      }
    }

    const c = this._applyConn
    try {
      await c.query('START TRANSACTION')
      const tbl = qi(ch.ns)
      if (ch.doc === null) {
        await c.query(`DELETE FROM ${tbl} WHERE ${qi(pk)} = ?`, [ch.id])
      } else {
        const cols = Object.keys(ch.doc)
        const vals = cols.map(k => jsonScalar(ch.doc[k]))
        const ph = cols.map(() => '?').join(',')
        const upd = cols.filter(k => k !== pk).map(k => `${qi(k)} = VALUES(${qi(k)})`).join(', ') || `${qi(pk)} = VALUES(${qi(pk)})`
        await c.query(`INSERT INTO ${tbl} (${cols.map(qi).join(',')}) VALUES (${ph}) ON DUPLICATE KEY UPDATE ${upd}`, vals)
      }
      await c.query(
        `INSERT INTO ${META} (ns, pk, v, \`by\`) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE v = VALUES(v), \`by\` = VALUES(\`by\`)`,
        [ch.ns, ch.id, ch.v, ch.by]
      )
      await c.query('COMMIT')
      return true
    } catch (e) {
      try { await c.query('ROLLBACK') } catch (_) {}
      if (!this._closed) console.error('[nazbu-mysql] apply error on', ch.ns, ch.id, '-', e.message)
      return false
    }
  }

  async close () {
    this._closed = true
    if (this._poll) clearInterval(this._poll)
    try { if (this._applyConn) { await this._applyConn.query('SET @nazbu_apply = 0'); this._applyConn.release() } } catch (_) {}
  }
}

module.exports = { MySqlStore }
