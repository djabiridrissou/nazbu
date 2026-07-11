'use strict'

/*
 * Real PostgreSQL validation of PostgresStore over live Nazbu P2P.
 * Two databases = two nodes (till-1 / till-2), same room, LAN transport.
 *
 * Needs a running Postgres. Point PG_URI at a maintenance DB (default below);
 * the test creates + drops its own `nazbu_a` / `nazbu_b` databases.
 *
 *   PG_URI=postgres://127.0.0.1:5432/postgres node test-postgres.js
 */

const { Pool, Client } = require('pg')
const Nazbu = require('../index')
const Bridge = require('../nazbu-mongo/bridge')      // storage-agnostic bridge
const { PostgresStore } = require('./store')

const BASE = process.env.PG_URI || 'postgres://127.0.0.1:5432/postgres'
const ROOM = 'nazbu-pg-test-' + process.pid
const wait = ms => new Promise(r => setTimeout(r, ms))
let failures = 0
const check = (l, c) => { console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`); if (!c) failures++ }

function dbUri (name) { const u = new URL(BASE); u.pathname = '/' + name; return u.toString() }

async function resetDb (name) {
  const admin = new Client({ connectionString: BASE })
  await admin.connect()
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [name]).catch(() => {})
  await admin.query(`DROP DATABASE IF EXISTS ${name}`)
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()
}

async function schema (pool) {
  await pool.query(`CREATE TABLE patients (id serial PRIMARY KEY, name text, status text)`)
  await pool.query(`CREATE TABLE sales (id text PRIMARY KEY, amount numeric)`)
}

async function main () {
  await resetDb('nazbu_a')
  await resetDb('nazbu_b')
  const poolA = new Pool({ connectionString: dbUri('nazbu_a') })
  const poolB = new Pool({ connectionString: dbUri('nazbu_b') })
  await schema(poolA)
  await schema(poolB)

  const policies = { sales: 'append-only', '*': 'last-writer-wins' }
  const A = new PostgresStore({ pool: poolA, name: 'till-1', policies })
  const B = new PostgresStore({ pool: poolB, name: 'till-2', policies })
  const a = new Bridge({ store: A, nazbu: new Nazbu({ name: 'till-1', room: ROOM, storage: './.nzp/A' }) })
  const b = new Bridge({ store: B, nazbu: new Nazbu({ name: 'till-2', room: ROOM, storage: './.nzp/B' }) })
  await a.start(); await b.start()
  await wait(3000)

  const one = async (pool, sql, args) => (await pool.query(sql, args)).rows[0]

  // 1 — INSERT propagates (last-writer-wins table)
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
  const cB = await one(poolB, `SELECT count(*)::int AS n FROM patients`)
  check('delete on till-1 removed the row on till-2', cB.n === 0)

  // 5 — ledger (append-only): concurrent inserts UNION, nothing lost
  await poolA.query(`INSERT INTO sales (id, amount) VALUES ('S-A', 10)`)
  await poolB.query(`INSERT INTO sales (id, amount) VALUES ('S-B', 20)`)
  await wait(3000)
  const sA = await one(poolA, `SELECT count(*)::int AS n, coalesce(sum(amount),0)::int AS t FROM sales`)
  const sB = await one(poolB, `SELECT count(*)::int AS n, coalesce(sum(amount),0)::int AS t FROM sales`)
  check('till-1 has both sales (union, total 30)', sA.n === 2 && sA.t === 30)
  check('till-2 has both sales (union, total 30)', sB.n === 2 && sB.t === 30)

  await A.close(); await B.close()
  await a.nazbu.close(); await b.nazbu.close()
  await poolA.end(); await poolB.end()

  console.log(`\n${failures === 0 ? 'ALL PASSED ✅' : failures + ' FAILED ❌'}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error('fatal:', err); process.exit(1) })
