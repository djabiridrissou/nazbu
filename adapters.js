'use strict'

/*
 * Adapter resolver for the one-line DX:
 *
 *     const room = new Nazbu({ db, room: 'shop-42', policies: { … } })
 *
 * Given a database handle, pick the right store adapter. Duck-typed so the core
 * never hard-depends on a database driver — the adapter (and its driver) is only
 * required when you actually pass `db`.
 */

function resolveStore (db, opts = {}) {
  // mongodb Db — has .collection()
  if (db && typeof db.collection === 'function') {
    let MongoTenantStore
    try { ({ MongoTenantStore } = require('./nazbu-mongo/tenant-sync')) }
    catch (e) { throw new Error('Nazbu: MongoDB adapter not found (' + e.message + ')') }
    return new MongoTenantStore({
      db,
      name: opts.name,
      tenantId: opts.tenantId || null,
      ledgerCollections: opts.ledger || ['stockmovements']
    })
  }

  // pg Pool — has .connect() and .query()
  if (db && typeof db.connect === 'function' && typeof db.query === 'function') {
    let PostgresStore
    try { ({ PostgresStore } = require('./nazbu-postgres/store')) }
    catch (e) { throw new Error('Nazbu: Postgres adapter needs the `pg` driver (npm i pg) — ' + e.message) }
    return new PostgresStore({
      pool: db,
      name: opts.name,
      policies: opts.policies || {},
      tables: opts.tables || null,
      exclude: opts.exclude || []
    })
  }

  // mysql2/promise Pool — has .getConnection() and .query()
  if (db && typeof db.getConnection === 'function' && typeof db.query === 'function') {
    let MySqlStore
    try { ({ MySqlStore } = require('./nazbu-mysql/store')) }
    catch (e) { throw new Error('Nazbu: MySQL adapter needs the `mysql2` driver (npm i mysql2) — ' + e.message) }
    return new MySqlStore({
      pool: db,
      name: opts.name,
      policies: opts.policies || {},
      tables: opts.tables || null,
      exclude: opts.exclude || []
    })
  }

  // better-sqlite3 Database — has .prepare() and .exec() (and no server methods)
  if (db && typeof db.prepare === 'function' && typeof db.exec === 'function') {
    let SqliteStore
    try { ({ SqliteStore } = require('./nazbu-sqlite/store')) }
    catch (e) { throw new Error('Nazbu: SQLite adapter needs the `better-sqlite3` driver (npm i better-sqlite3) — ' + e.message) }
    return new SqliteStore({
      db,
      name: opts.name,
      policies: opts.policies || {},
      tables: opts.tables || null,
      exclude: opts.exclude || []
    })
  }

  throw new Error('Nazbu: unrecognised `db`. Pass a pg Pool, a mysql2 Pool, a better-sqlite3 Database, or a mongodb Db.')
}

module.exports = { resolveStore }
