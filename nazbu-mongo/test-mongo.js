'use strict'

/*
 * REAL MongoDB validation of MongoLedgerStore (needs a replica set), including
 * MULTI-TENANT isolation: two tills scoped to tenant A must sync tenant A's
 * movements and NEVER see tenant B's.
 *
 *   node test-mongo.js
 */

const { MongoClient, ObjectId } = require('mongodb')
const Nazbu = require('../index')
const Bridge = require('./bridge')
const { MongoLedgerStore } = require('./stores')

const URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27055/?replicaSet=rs0'
const ROOM = 'mongo-tenant-test'
const wait = ms => new Promise(r => setTimeout(r, ms))
let failures = 0
const check = (l, c) => { console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`); if (!c) failures++ }

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

  const tenantA = new ObjectId()
  const tenantB = new ObjectId() // a DIFFERENT tenant that must NOT sync

  // Both tills are scoped to tenant A only.
  const A = new MongoLedgerStore({ db: db1, name: 'till-1', tenantId: String(tenantA) })
  const B = new MongoLedgerStore({ db: db2, name: 'till-2', tenantId: String(tenantA) })
  const a = new Bridge({ store: A, nazbu: new Nazbu({ name: 'till-1', room: ROOM, storage: './.nzm/A' }) })
  const b = new Bridge({ store: B, nazbu: new Nazbu({ name: 'till-2', room: ROOM, storage: './.nzm/B' }) })
  await a.start(); await b.start()
  await wait(2500)

  const productId = new ObjectId()
  const locationId = new ObjectId()
  const level = async db => ((await db.collection('stocklevels').findOne({ productId, locationId })) || {}).totalQty

  // Tenant A: receipt +5 on till-1.
  await recordLocal(db1, { productId, locationId, qtyDelta: 5, type: 'receipt', tenantId: tenantA })
  // Tenant B: a movement on till-1 that MUST NOT cross to till-2.
  const productB = new ObjectId()
  await recordLocal(db1, { productId: productB, locationId, qtyDelta: 99, type: 'receipt', tenantId: tenantB })
  await wait(2500)

  check('tenant A receipt reached till-2 (level 5)', (await level(db2)) === 5)
  check('tenant B movement did NOT leak to till-2', (await db2.collection('stockmovements').countDocuments({ tenantId: tenantB })) === 0)

  // Tenant A oversell: each till sells 3.
  for (let i = 0; i < 3; i++) await recordLocal(db1, { productId, locationId, qtyDelta: -1, type: 'sale', tenantId: tenantA })
  for (let i = 0; i < 3; i++) await recordLocal(db2, { productId, locationId, qtyDelta: -1, type: 'sale', tenantId: tenantA })
  await wait(4500)

  check('till-1 tenant A level == -1 (oversell)', (await level(db1)) === -1)
  check('till-2 tenant A level == -1 (converged)', (await level(db2)) === -1)
  check('till-2 still has NONE of tenant B', (await db2.collection('stockmovements').countDocuments({ tenantId: tenantB })) === 0)

  await A.close(); await B.close()
  await client.close()
  console.log(`\n${failures === 0 ? 'ALL PASSED ✅' : failures + ' FAILED ❌'}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error('fatal:', err); process.exit(1) })
