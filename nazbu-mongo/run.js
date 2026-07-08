#!/usr/bin/env node
'use strict'

/*
 * Run the Nazbu ↔ Mongo stock bridge next to a Womola instance.
 *
 *   node run.js --room shop-42 --name till-1 \
 *               --uri "mongodb://127.0.0.1:27017/?replicaSet=rs0" --db womoladb
 *
 * Start it on each machine (same --room per shop). It watches the local
 * StockMovement ledger and syncs it peer-to-peer over the LAN — no server, no
 * internet — without touching Womola. Ctrl+C to stop.
 */

const { MongoClient } = require('mongodb')
let Nazbu; try { Nazbu = require('nazbu') } catch (_) { Nazbu = require('../index') }
const Bridge = require('./bridge')
const { MongoLedgerStore } = require('./stores')
const { MongoTenantStore } = require('./tenant-sync')

function arg (name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return process.env['NAZBU_' + name.toUpperCase()] || def
}

const uri = arg('uri', 'mongodb://127.0.0.1:27017/?replicaSet=rs0')
const dbName = arg('db', 'womoladb')
const room = arg('room', 'womola-shop')
const name = arg('name', 'till-' + process.pid)
const collection = arg('collection', 'stockmovements')
// Multi-tenant: scope sync to ONE tenant. REQUIRED on a multi-tenant Womola,
// or a shop would receive every tenant's data.
const tenantId = arg('tenant', '') || null
// --internet also syncs over the DHT (offline shop → online boss), on top of LAN.
const internet = process.argv.includes('--internet') || process.env.NAZBU_INTERNET === '1'
// --full = replicate the tenant's ENTIRE database (all collections) for full
// offline Womola. Without it, only the stock ledger syncs.
const full = process.argv.includes('--full') || process.env.NAZBU_FULL === '1'
// Ledger = insert-only/union collections. ONLY stockmovements needs this: it's
// genuinely append-only AND drives the commutative stocklevels projection. Every
// other collection (sales, transactions, accountingevents, salereturns, …) gets
// UPDATED in place by the app (void, mark-paid, post-to-accounting …), and ledger
// mode treats docs as immutable → those updates never sync. So everything except
// stockmovements is last-write-wins, which propagates updates. Keeping this list
// minimal is also future-proof: a newly-mutated collection just works.
const ledgerCollections = arg('ledger', 'stockmovements')
  .split(',').map(s => s.trim()).filter(Boolean)

async function main () {
  const client = await new MongoClient(uri).connect()
  const db = client.db(dbName)
  const store = full
    ? new MongoTenantStore({ db, name, tenantId, ledgerCollections })
    : new MongoLedgerStore({ db, name, collection, tenantId })
  const nazbu = new Nazbu({ name, room, internet })
  const bridge = new Bridge({ store, nazbu })
  await bridge.start()

  console.log(`\n[nazbu-mongo] ${full ? 'FULL tenant DB' : dbName + '.' + collection}   room "${room}"   as "${name}"`)
  console.log(`[nazbu-mongo] tenant scope: ${tenantId || 'ALL (single-tenant only!)'}`)
  console.log(`[nazbu-mongo] transports: LAN${internet ? ' + internet (boss sync)' : ''} — no central server.`)
  console.log('[nazbu-mongo] watching stock movements — syncing peer-to-peer.\n')

  // Log a fresh line whenever connectivity or movement counts change (so it
  // shows up in `docker logs`, not just an in-place status line).
  let last = ''
  setInterval(() => {
    const line = `linked:${nazbu.links}  movements out:${bridge.sent} in:${bridge.applied}`
    if (line !== last) { last = line; console.log('[nazbu-mongo] ' + line) }
  }, 2000)

  process.on('SIGINT', async () => { try { await store.close(); await client.close() } catch (_) {}; process.exit(0) })
}

main().catch(err => { console.error('[nazbu-mongo] fatal:', err.message); process.exit(1) })
