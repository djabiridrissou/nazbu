'use strict'

/*
 * REAL MongoDB validation of MongoLedgerStore (needs a replica set).
 *
 * Simulates two tills as two databases (till1db / till2db) on one replica set.
 * "Womola" is simulated by recordLocal(): it inserts a StockMovement AND $inc's
 * StockLevel — exactly what inventory.service.updateStockLevel() does. The
 * bridge then syncs movements peer-to-peer and projects REMOTE ones.
 *
 *   node test-mongo.js
 */

const { MongoClient, ObjectId } = require('mongodb')
const Nazbu = require('../index')
const Bridge = require('./bridge')
const { MongoLedgerStore } = require('./stores')

const URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27055/?replicaSet=rs0'
const ROOM = 'mongo-stock-test'
const wait = ms => new Promise(r => setTimeout(r, ms))
let failures = 0
const check = (l, c) => { console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`); if (!c) failures++ }

// Simulate Womola writing a local movement (insert + project into StockLevel).
async function recordLocal (db, mv) {
  await db.collection('stockmovements').insertOne({ _id: new ObjectId(), ...mv })
  await db.collection('stocklevels').updateOne(
    { productId: mv.productId, locationId: mv.locationId },
    { $inc: { totalQty: mv.qtyDelta, availableQty: mv.qtyDelta }, $set: { lastUpdated: new Date() } },
    { upsert: true }
  )
}

async function main () {
  const client = await new MongoClient(URI).connect()
  const db1 = client.db('till1db')
  const db2 = client.db('till2db')
  for (const db of [db1, db2]) {
    await db.collection('stockmovements').deleteMany({})
    await db.collection('stocklevels').deleteMany({})
    await db.collection('_nazbu_meta').deleteMany({})
  }

  const A = new MongoLedgerStore({ db: db1, name: 'till-1' })
  const B = new MongoLedgerStore({ db: db2, name: 'till-2' })
  const a = new Bridge({ store: A, nazbu: new Nazbu({ name: 'till-1', room: ROOM, storage: './.nzm/A' }) })
  const b = new Bridge({ store: B, nazbu: new Nazbu({ name: 'till-2', room: ROOM, storage: './.nzm/B' }) })
  await a.start(); await b.start()
  await wait(2500)

  const productId = new ObjectId()
  const locationId = new ObjectId()
  const q = { productId, locationId }
  const level = async db => ((await db.collection('stocklevels').findOne(q)) || {}).totalQty

  // Receipt +5 on till-1 (Womola-style local write).
  await recordLocal(db1, { productId, locationId, qtyDelta: 5, type: 'receipt' })
  await wait(2500)
  check('till-2 db received the receipt movement', !!(await db2.collection('stockmovements').findOne({ qtyDelta: 5 })))
  check('till-2 StockLevel projected to 5', (await level(db2)) === 5)

  // Offline oversell: each till sells 3 (only 5 exist).
  for (let i = 0; i < 3; i++) await recordLocal(db1, { productId, locationId, qtyDelta: -1, type: 'sale' })
  for (let i = 0; i < 3; i++) await recordLocal(db2, { productId, locationId, qtyDelta: -1, type: 'sale' })
  await wait(4500)

  check('till-1 holds all 7 movements', (await db1.collection('stockmovements').countDocuments(q)) === 7)
  check('till-2 holds all 7 movements', (await db2.collection('stockmovements').countDocuments(q)) === 7)
  check('till-1 StockLevel == -1 (oversell surfaced)', (await level(db1)) === -1)
  check('till-2 StockLevel == -1 (converged, identical)', (await level(db2)) === -1)

  await A.close(); await B.close()
  await client.close()
  console.log(`\n${failures === 0 ? 'ALL PASSED ✅' : failures + ' FAILED ❌'}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error('fatal:', err); process.exit(1) })
