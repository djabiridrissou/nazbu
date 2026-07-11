'use strict'

/*
 * Real SQLite validation of SqliteStore over live Nazbu P2P.
 * Two database files = two nodes (till-1 / till-2), same room, LAN transport.
 *
 *   node test-sqlite.js
 */

const os = require('os')
const path = require('path')
const fs = require('fs')
const Database = require('better-sqlite3')
const Nazbu = require('../index')
const Bridge = require('../nazbu-mongo/bridge')
const { SqliteStore } = require('./store')

const ROOM = 'nazbu-sqlite-test-' + process.pid
const wait = ms => new Promise(r => setTimeout(r, ms))
let failures = 0
const check = (l, c) => { console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`); if (!c) failures++ }

function freshDb () {
  const p = path.join(os.tmpdir(), `nazbu-sqlite-${process.pid}-${Math.floor(process.hrtime()[1] % 1e6)}-${Math.random().toString(36).slice(2, 8)}.db`)
  try { fs.rmSync(p, { force: true }) } catch (_) {}
  const db = new Database(p)
  db.exec(`CREATE TABLE patients (id INTEGER PRIMARY KEY, name TEXT, status TEXT);
           CREATE TABLE sales (id TEXT PRIMARY KEY, amount REAL);`)
  return { db, p }
}

async function main () {
  const A_ = freshDb(); const B_ = freshDb()
  const dbA = A_.db; const dbB = B_.db
  const policies = { sales: 'append-only', '*': 'last-writer-wins' }
  const A = new SqliteStore({ db: dbA, name: 'till-1', policies, pollMs: 250 })
  const B = new SqliteStore({ db: dbB, name: 'till-2', policies, pollMs: 250 })
  const a = new Bridge({ store: A, nazbu: new Nazbu({ name: 'till-1', room: ROOM, storage: './.nzsq/A' }) })
  const b = new Bridge({ store: B, nazbu: new Nazbu({ name: 'till-2', room: ROOM, storage: './.nzsq/B' }) })
  await a.start(); await b.start()
  await wait(3000)

  const get = (db, sql, ...args) => db.prepare(sql).get(...args)

  dbA.prepare(`INSERT INTO patients (name, status) VALUES ('Ada', 'admitted')`).run() // id = 1
  await wait(2000)
  const pB = get(dbB, `SELECT name, status FROM patients WHERE id = 1`)
  check('insert on till-1 reached till-2', !!pB && pB.name === 'Ada' && pB.status === 'admitted')

  dbA.prepare(`UPDATE patients SET status = 'discharged' WHERE id = 1`).run()
  await wait(2000)
  check('update on till-1 reflected on till-2', get(dbB, `SELECT status FROM patients WHERE id = 1`).status === 'discharged')

  dbB.prepare(`UPDATE patients SET status = 'in-surgery' WHERE id = 1`).run()
  await wait(2000)
  check('update on till-2 reflected back on till-1', get(dbA, `SELECT status FROM patients WHERE id = 1`).status === 'in-surgery')

  dbA.prepare(`DELETE FROM patients WHERE id = 1`).run()
  await wait(2000)
  check('delete on till-1 removed the row on till-2', get(dbB, `SELECT COUNT(*) AS n FROM patients`).n === 0)

  dbA.prepare(`INSERT INTO sales (id, amount) VALUES ('S-A', 10)`).run()
  dbB.prepare(`INSERT INTO sales (id, amount) VALUES ('S-B', 20)`).run()
  await wait(2500)
  const sA = get(dbA, `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS t FROM sales`)
  const sB = get(dbB, `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS t FROM sales`)
  check('till-1 has both sales (union, total 30)', sA.n === 2 && sA.t === 30)
  check('till-2 has both sales (union, total 30)', sB.n === 2 && sB.t === 30)

  A.close(); B.close()
  await a.nazbu.close(); await b.nazbu.close()
  dbA.close(); dbB.close()
  try { fs.rmSync(A_.p, { force: true }); fs.rmSync(B_.p, { force: true }) } catch (_) {}

  console.log(`\n${failures === 0 ? 'ALL PASSED ✅' : failures + ' FAILED ❌'}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error('fatal:', err); process.exit(1) })
