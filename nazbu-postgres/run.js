#!/usr/bin/env node
'use strict'

/*
 * Run the Nazbu ↔ PostgreSQL bridge next to your app.
 *
 *   node run.js --room shop-42 --name till-1 \
 *               --uri "postgres://user:pass@127.0.0.1:5432/mydb" \
 *               --ledger sales,stock_movements --internet
 *
 * Start it on each machine (same --room per site). It watches your tables and
 * syncs them peer-to-peer over the LAN — and over the internet with --internet —
 * without touching your app. Ctrl+C to stop.
 */

const { Pool } = require('pg')
let Nazbu; try { Nazbu = require('nazbu') } catch (_) { Nazbu = require('../index') }
const Bridge = require('../nazbu-mongo/bridge') // the bridge is storage-agnostic
const { PostgresStore } = require('./store')

function arg (name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return process.env['NAZBU_' + name.toUpperCase()] || def
}

const uri = arg('uri', 'postgres://127.0.0.1:5432/postgres')
const room = arg('room', 'nazbu-pg')
const name = arg('name', 'pg-' + process.pid)
const internet = process.argv.includes('--internet') || process.env.NAZBU_INTERNET === '1'
const tables = (arg('tables', '') || '').split(',').map(s => s.trim()).filter(Boolean)
const exclude = (arg('exclude', '') || '').split(',').map(s => s.trim()).filter(Boolean)
const ledger = (arg('ledger', '') || '').split(',').map(s => s.trim()).filter(Boolean)

// Build the per-table conflict policy: everything is last-writer-wins except the
// tables you flag as --ledger (append-only, never overwritten — for money).
const policies = { '*': 'last-writer-wins' }
for (const t of ledger) policies[t] = 'append-only'

async function main () {
  const pool = new Pool({ connectionString: uri })
  const store = new PostgresStore({ pool, name, policies, tables: tables.length ? tables : null, exclude })
  const nazbu = new Nazbu({ name, room, internet })
  const bridge = new Bridge({ store, nazbu })
  await bridge.start()

  console.log(`\n[nazbu-pg] ${uri.replace(/\/\/[^@]*@/, '//***@')}   room "${room}"   as "${name}"`)
  console.log(`[nazbu-pg] transports: LAN${internet ? ' + internet' : ''} — no central server.`)
  console.log(`[nazbu-pg] ledger (append-only) tables: ${ledger.join(', ') || '(none — all last-writer-wins)'}\n`)

  let last = ''
  setInterval(() => {
    const line = `linked:${nazbu.links}  rows out:${bridge.sent} in:${bridge.applied}`
    if (line !== last) { last = line; console.log('[nazbu-pg] ' + line) }
  }, 2000)

  process.on('SIGINT', async () => { try { await store.close(); await pool.end() } catch (_) {}; process.exit(0) })
}

main().catch(err => { console.error('[nazbu-pg] fatal:', err.message); process.exit(1) })
