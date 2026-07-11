'use strict'

/*
 * Real MySQL validation of MySqlStore over live Nazbu P2P.
 * Two databases = two nodes (till-1 / till-2), same room, LAN transport.
 *
 * Needs a running MySQL. Point MYSQL_URI at it (no database); the test creates
 * and drops its own `nazbu_a` / `nazbu_b` databases.
 *
 *   MYSQL_URI=mysql://root@127.0.0.1:3306 node test-mysql.js
 */

const mysql = require('mysql2/promise')
const Nazbu = require('../index')
const Bridge = require('../nazbu-mongo/bridge')
const { MySqlStore } = require('./store')

const BASE = process.env.MYSQL_URI || 'mysql://root@127.0.0.1:3306'
const ROOM = 'nazbu-mysql-test-' + process.pid
const wait = ms => new Promise(r => setTimeout(r, ms))
let failures = 0
const check = (l, c) => { console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`); if (!c) failures++ }
const num = v => (v == null ? 0 : Number(v))

async function resetDb (name) {
  const admin = await mysql.createConnection(BASE)
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``)
  await admin.query(`CREATE DATABASE \`${name}\``)
  await admin.end()
}

async function schema (pool) {
  await pool.query(`CREATE TABLE patients (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(191), status VARCHAR(191))`)
  await pool.query(`CREATE TABLE sales (id VARCHAR(191) PRIMARY KEY, amount DECIMAL(10,2))`)
}

async function main () {
  await resetDb('nazbu_a')
  await resetDb('nazbu_b')
  const poolA = mysql.createPool(BASE + '/nazbu_a')
  const poolB = mysql.createPool(BASE + '/nazbu_b')
  await schema(poolA)
  await schema(poolB)

  const policies = { sales: 'append-only', '*': 'last-writer-wins' }
  const A = new MySqlStore({ pool: poolA, name: 'till-1', policies, pollMs: 400 })
  const B = new MySqlStore({ pool: poolB, name: 'till-2', policies, pollMs: 400 })
  const a = new Bridge({ store: A, nazbu: new Nazbu({ name: 'till-1', room: ROOM, storage: './.nzmy/A' }) })
  const b = new Bridge({ store: B, nazbu: new Nazbu({ name: 'till-2', room: ROOM, storage: './.nzmy/B' }) })
  await a.start(); await b.start()
  await wait(3000)

  const one = async (pool, sql, args) => (await pool.query(sql, args))[0][0]

  // 1 — INSERT propagates (last-writer-wins)
  await poolA.query(`INSERT INTO patients (name, status) VALUES ('Ada', 'admitted')`) // id = 1
  await wait(2500)
  const pB = await one(poolB, `SELECT name, status FROM patients WHERE id = 1`)
  check('insert on till-1 reached till-2', !!pB && pB.name === 'Ada' && pB.status === 'admitted')

  // 2 — UPDATE propagates
  await poolA.query(`UPDATE patients SET status = 'discharged' WHERE id = 1`)
  await wait(2500)
  const pB2 = await one(poolB, `SELECT status FROM patients WHERE id = 1`)
  check('update on till-1 reflected on till-2', !!pB2 && pB2.status === 'discharged')

  // 3 — cross-direction UPDATE (till-2 wins, newer)
  await poolB.query(`UPDATE patients SET status = 'in-surgery' WHERE id = 1`)
  await wait(2500)
  const pA = await one(poolA, `SELECT status FROM patients WHERE id = 1`)
  check('update on till-2 reflected back on till-1', !!pA && pA.status === 'in-surgery')

  // 4 — DELETE propagates
  await poolA.query(`DELETE FROM patients WHERE id = 1`)
  await wait(2500)
  const cB = await one(poolB, `SELECT COUNT(*) AS n FROM patients`)
  check('delete on till-1 removed the row on till-2', num(cB.n) === 0)

  // 5 — ledger (append-only): concurrent inserts UNION, nothing lost
  await poolA.query(`INSERT INTO sales (id, amount) VALUES ('S-A', 10)`)
  await poolB.query(`INSERT INTO sales (id, amount) VALUES ('S-B', 20)`)
  await wait(3000)
  const sA = await one(poolA, `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS t FROM sales`)
  const sB = await one(poolB, `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS t FROM sales`)
  check('till-1 has both sales (union, total 30)', num(sA.n) === 2 && num(sA.t) === 30)
  check('till-2 has both sales (union, total 30)', num(sB.n) === 2 && num(sB.t) === 30)

  await A.close(); await B.close()
  await a.nazbu.close(); await b.nazbu.close()
  await poolA.end(); await poolB.end()

  console.log(`\n${failures === 0 ? 'ALL PASSED ✅' : failures + ' FAILED ❌'}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error('fatal:', err); process.exit(1) })
