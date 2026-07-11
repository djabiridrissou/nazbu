'use strict'

/*
 * SqliteStore — a Nazbu store adapter for SQLite (via better-sqlite3).
 *
 * Same contract as the other adapters (onLocalChange / applyRemote / close / start),
 * but synchronous under the hood — SQLite is in-process.
 *
 * Capture, without touching your tables:
 *   Three AFTER triggers (INSERT/UPDATE/DELETE) per tracked table write every row
 *   change into a _nazbu_outbox table. SQLite has no notifications, so the adapter
 *   polls the outbox and drains it in order. Your tables are never altered.
 *
 * Echo prevention:
 *   A tiny control row (_nazbu_ctl.apply). When WE apply a peer's change we flip it
 *   to 1 inside the write transaction; every trigger has `WHEN apply = 0`, so applied
 *   changes are skipped and never bounce back out.
 *
 * Conflicts (per table, from `policies`): last-writer-wins (Lamport `v` in _nazbu_meta)
 * or append-only (insert-once, deduped by primary key).
 */

const OUTBOX = '_nazbu_outbox'
const META = '_nazbu_meta'
const CURSOR = '_nazbu_cursor'
const CTL = '_nazbu_ctl'

const qi = (n) => '"' + String(n).replace(/"/g, '""') + '"'
const sqScalar = (v) => {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'object') return JSON.stringify(v)
  return v
}

class SqliteStore {
  constructor ({ db, name, policies = {}, tables = null, exclude = [], pollMs = 500 }) {
    if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
      throw new Error('SqliteStore needs a better-sqlite3 Database (new Database(file))')
    }
    this.db = db
    this.name = name || 'sqlite-' + process.pid
    this.policies = policies || {}
    this.tablesAllow = tables ? tables.map(String) : null
    this.exclude = new Set((exclude || []).map(String))
    this.pollMs = pollMs
    this.clock = 0
    this.cursor = 0
    this.pk = new Map()
    this._cb = null
    this._poll = null
    this._draining = false
    this._closed = false
  }

  policyFor (ns) {
    const p = this.policies[ns] || this.policies['*'] || 'last-writer-wins'
    return (p === 'append-only' || p === 'ledger') ? 'append-only' : 'last-writer-wins'
  }

  _ensureInfra () {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${OUTBOX} (seq INTEGER PRIMARY KEY AUTOINCREMENT, ns TEXT, pk TEXT, op TEXT, row TEXT);
      CREATE TABLE IF NOT EXISTS ${META} (ns TEXT, pk TEXT, v INTEGER, "by" TEXT, PRIMARY KEY (ns, pk));
      CREATE TABLE IF NOT EXISTS ${CURSOR} (id INTEGER PRIMARY KEY, seq INTEGER);
      INSERT OR IGNORE INTO ${CURSOR} (id, seq) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS ${CTL} (k TEXT PRIMARY KEY, v INTEGER);
      INSERT OR IGNORE INTO ${CTL} (k, v) VALUES ('apply', 0);
    `)
    const cur = this.db.prepare(`SELECT seq FROM ${CURSOR} WHERE id = 1`).get()
    this.cursor = Number(cur ? cur.seq : 0)
    const mx = this.db.prepare(`SELECT COALESCE(MAX(v), 0) AS v FROM ${META}`).get()
    this.clock = Number(mx.v)
  }

  _discoverTables () {
    const rows = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
         AND name NOT LIKE '\\_nazbu\\_%' ESCAPE '\\'
         AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`
    ).all()
    let names = rows.map(r => r.name)
    if (this.tablesAllow) names = names.filter(n => this.tablesAllow.includes(n))
    return names.filter(n => !this.exclude.has(n))
  }

  _cols (t) { return this.db.prepare(`SELECT name FROM pragma_table_info(?)`).all(t).map(r => r.name) }
  _pkCols (t) { return this.db.prepare(`SELECT name FROM pragma_table_info(?) WHERE pk > 0`).all(t).map(r => r.name) }

  _installTriggers (t, cols, pk) {
    const objOf = (ref) => 'json_object(' + cols.map(c => `'${c}', ${ref}.${qi(c)}`).join(', ') + ')'
    const gate = `WHEN (SELECT v FROM ${CTL} WHERE k = 'apply') = 0`
    const mk = (suffix, event, ref, rowExpr) =>
      `DROP TRIGGER IF EXISTS ${qi('_nazbu_' + t + '_' + suffix)};\n` +
      `CREATE TRIGGER ${qi('_nazbu_' + t + '_' + suffix)} AFTER ${event} ON ${qi(t)} ${gate}\n` +
      `BEGIN\n` +
      `  INSERT INTO ${OUTBOX} (ns, pk, op, row) VALUES ('${t}', CAST(${ref}.${qi(pk)} AS TEXT), '${event}', ${rowExpr});\n` +
      `END;`
    this.db.exec(mk('ai', 'INSERT', 'NEW', objOf('NEW')))
    this.db.exec(mk('au', 'UPDATE', 'NEW', objOf('NEW')))
    this.db.exec(mk('ad', 'DELETE', 'OLD', 'NULL'))
  }

  start () {
    try { this.db.pragma('journal_mode = WAL') } catch (_) {}
    this._ensureInfra()
    const tracked = []
    for (const t of this._discoverTables()) {
      const pks = this._pkCols(t)
      if (pks.length !== 1) { console.warn(`[nazbu-sqlite] skipping "${t}" — needs a single-column primary key`); continue }
      this.pk.set(t, pks[0])
      this._installTriggers(t, this._cols(t), pks[0])
      tracked.push(t)
    }
    this._poll = setInterval(() => this._drain(), this.pollMs)
    if (this._poll.unref) this._poll.unref()
    console.log(`[nazbu-sqlite] tracking ${tracked.length} table(s): ${tracked.join(', ') || '(none)'}`)
    this._drain()
    return this
  }

  onLocalChange (cb) { this._cb = cb; this._drain() }

  _drain () {
    if (!this._cb || this._closed || this._draining) return
    this._draining = true
    try {
      for (;;) {
        const rows = this.db.prepare(
          `SELECT seq, ns, pk, op, row FROM ${OUTBOX} WHERE seq > ? ORDER BY seq LIMIT 200`
        ).all(this.cursor)
        if (!rows.length) break
        const setMeta = this.db.prepare(
          `INSERT INTO ${META} (ns, pk, v, "by") VALUES (?,?,?,?)
           ON CONFLICT(ns, pk) DO UPDATE SET v = excluded.v, "by" = excluded."by"`
        )
        for (const r of rows) {
          const v = ++this.clock
          setMeta.run(r.ns, r.pk, v, this.name)
          const doc = r.op === 'DELETE' ? null : JSON.parse(r.row)
          this._cb({ ns: r.ns, id: String(r.pk), doc, v, by: this.name, pol: this.policyFor(r.ns) })
          this.cursor = Number(r.seq)
        }
        this.db.prepare(`UPDATE ${CURSOR} SET seq = ? WHERE id = 1`).run(this.cursor)
        this.db.prepare(`DELETE FROM ${OUTBOX} WHERE seq <= ?`).run(this.cursor)
      }
    } catch (e) {
      if (!this._closed) console.error('[nazbu-sqlite] drain error:', e.message)
    } finally {
      this._draining = false
    }
  }

  applyRemote (ch) {
    if (this._closed) return false
    const pk = this.pk.get(ch.ns)
    if (!pk) return false
    this.clock = Math.max(this.clock, Number(ch.v) || 0)
    const pol = ch.pol || this.policyFor(ch.ns)

    if (pol === 'append-only') {
      if (this.db.prepare(`SELECT 1 FROM ${META} WHERE ns = ? AND pk = ?`).get(ch.ns, ch.id)) return false
    } else {
      const m = this.db.prepare(`SELECT v, "by" AS b FROM ${META} WHERE ns = ? AND pk = ?`).get(ch.ns, ch.id)
      if (m) {
        const cv = Number(m.v)
        if (cv > ch.v || (cv === ch.v && String(m.b) >= ch.by)) return false
      }
    }

    try {
      const tx = this.db.transaction(() => {
        this.db.prepare(`UPDATE ${CTL} SET v = 1 WHERE k = 'apply'`).run()
        const tbl = qi(ch.ns)
        if (ch.doc === null) {
          this.db.prepare(`DELETE FROM ${tbl} WHERE ${qi(pk)} = ?`).run(ch.id)
        } else {
          const cols = Object.keys(ch.doc)
          const vals = cols.map(k => sqScalar(ch.doc[k]))
          const ph = cols.map(() => '?').join(', ')
          const upd = cols.filter(k => k !== pk).map(k => `${qi(k)} = excluded.${qi(k)}`).join(', ') || `${qi(pk)} = excluded.${qi(pk)}`
          this.db.prepare(`INSERT INTO ${tbl} (${cols.map(qi).join(', ')}) VALUES (${ph}) ON CONFLICT(${qi(pk)}) DO UPDATE SET ${upd}`).run(vals)
        }
        this.db.prepare(
          `INSERT INTO ${META} (ns, pk, v, "by") VALUES (?,?,?,?)
           ON CONFLICT(ns, pk) DO UPDATE SET v = excluded.v, "by" = excluded."by"`
        ).run(ch.ns, ch.id, ch.v, ch.by)
        this.db.prepare(`UPDATE ${CTL} SET v = 0 WHERE k = 'apply'`).run()
      })
      tx()
      return true
    } catch (e) {
      if (!this._closed) console.error('[nazbu-sqlite] apply error on', ch.ns, ch.id, '-', e.message)
      return false
    }
  }

  close () {
    this._closed = true
    if (this._poll) clearInterval(this._poll)
    // The Database is owned by the caller — we don't close it here.
  }
}

module.exports = { SqliteStore }
