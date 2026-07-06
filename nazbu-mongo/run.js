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

async function main () {
  const client = await new MongoClient(uri).connect()
  const db = client.db(dbName)
  const store = new MongoLedgerStore({ db, name, collection })
  const nazbu = new Nazbu({ name, room })
  const bridge = new Bridge({ store, nazbu })
  await bridge.start()

  console.log(`\n[nazbu-mongo] bridging ${dbName}.${collection}   room "${room}"   as "${name}"`)
  console.log('[nazbu-mongo] watching stock movements — peer-to-peer, no server, no internet.\n')
  setInterval(() => {
    process.stdout.write(`\r[nazbu-mongo] linked peers: ${nazbu.links}    out: ${bridge.sent}   in: ${bridge.applied}     `)
  }, 2000)

  process.on('SIGINT', async () => { try { await store.close(); await client.close() } catch (_) {}; process.exit(0) })
}

main().catch(err => { console.error('[nazbu-mongo] fatal:', err.message); process.exit(1) })
