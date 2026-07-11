#!/usr/bin/env node
'use strict'

/*
 * Run the Nazbu ↔ SQLite bridge next to your app.
 *
 *   node run.js --room shop-42 --name till-1 --file ./app.db --ledger sales --internet
 *
 * Start it on each machine (same --room per site). It watches your tables and
 * syncs them peer-to-peer — no server. Ctrl+C to stop.
 */

const Database = require('better-sqlite3')
let Nazbu; try { Nazbu = require('nazbu') } catch (_) { Nazbu = require('../index') }
const Bridge = require('../nazbu-mongo/bridge')
const { SqliteStore } = require('./store')

function arg (name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return process.env['NAZBU_' + name.toUpperCase()] || def
}

const file = arg('file', './app.db')
const room = arg('room', 'nazbu-sqlite')
const name = arg('name', 'sqlite-' + process.pid)
const internet = process.argv.includes('--internet') || process.env.NAZBU_INTERNET === '1'
const tables = (arg('tables', '') || '').split(',').map(s => s.trim()).filter(Boolean)
const exclude = (arg('exclude', '') || '').split(',').map(s => s.trim()).filter(Boolean)
const ledger = (arg('ledger', '') || '').split(',').map(s => s.trim()).filter(Boolean)

const policies = { '*': 'last-writer-wins' }
for (const t of ledger) policies[t] = 'append-only'

async function main () {
  const db = new Database(file)
  const store = new SqliteStore({ db, name, policies, tables: tables.length ? tables : null, exclude })
  const nazbu = new Nazbu({ name, room, internet })
  const bridge = new Bridge({ store, nazbu })
  await bridge.start()

  console.log(`\n[nazbu-sqlite] ${file}   room "${room}"   as "${name}"`)
  console.log(`[nazbu-sqlite] transports: LAN${internet ? ' + internet' : ''} — no central server.`)
  console.log(`[nazbu-sqlite] ledger (append-only) tables: ${ledger.join(', ') || '(none — all last-writer-wins)'}\n`)

  let last = ''
  setInterval(() => {
    const line = `linked:${nazbu.links}  rows out:${bridge.sent} in:${bridge.applied}`
    if (line !== last) { last = line; console.log('[nazbu-sqlite] ' + line) }
  }, 2000)

  process.on('SIGINT', () => { try { store.close(); db.close() } catch (_) {}; process.exit(0) })
}

main().catch(err => { console.error('[nazbu-sqlite] fatal:', err.message); process.exit(1) })
