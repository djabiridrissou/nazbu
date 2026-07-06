'use strict'

/*
 * Full tenant-slice sync over real Mongo + Nazbu P2P:
 *   - a mutable entity (product) syncs, updates via LWW, and deletes propagate
 *   - an append-only ledger doc (stockmovement) syncs by union
 *   - BSON types (ObjectId) are preserved so references keep matching
 *   - another tenant's data never crosses
 *
 *   node test-tenant-full.js
 */

const { MongoClient, ObjectId } = require('mongodb')
const Nazbu = require('../index')
const Bridge = require('./bridge')
const { MongoTenantStore } = require('./tenant-sync')

const URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27055/?replicaSet=rs0'
const ROOM = 'mongo-tenant-full'
const wait = ms => new Promise(r => setTimeout(r, ms))
let failures = 0
const check = (l, c) => { console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`); if (!c) failures++ }

async function main () {
  const client = await new MongoClient(URI).connect()
  const db1 = client.db('shopA'); const db2 = client.db('bossA')
  for (const db of [db1, db2]) for (const c of ['products', 'stockmovements', '_nazbu_meta']) await db.collection(c).deleteMany({})

  const tenantA = new ObjectId(); const tenantB = new ObjectId()
  const opts = t => ({ db: t, name: t === db1 ? 'shop' : 'boss', tenantId: String(tenantA), ledgerCollections: ['stockmovements'] })
  const a = new Bridge({ store: new MongoTenantStore(opts(db1)), nazbu: new Nazbu({ name: 'shop', room: ROOM, storage: './.nzt/A' }) })
  const b = new Bridge({ store: new MongoTenantStore(opts(db2)), nazbu: new Nazbu({ name: 'boss', room: ROOM, storage: './.nzt/B' }) })
  await a.start(); await b.start(); await wait(2500)

  const pid = new ObjectId()

  // 1) mutable entity insert → syncs, ObjectId _id preserved.
  await db1.collection('products').insertOne({ _id: pid, tenantId: tenantA, name: 'Paracetamol', price: 10 })
  await wait(2000)
  const p2 = await db2.collection('products').findOne({ _id: pid }) // matches only if _id stayed an ObjectId
  check('product synced to boss with ObjectId preserved', !!p2 && p2.name === 'Paracetamol')

  // 2) LWW update.
  await db1.collection('products').updateOne({ _id: pid }, { $set: { price: 12 } })
  await wait(2000)
  check('LWW update propagated (price 12)', ((await db2.collection('products').findOne({ _id: pid })) || {}).price === 12)

  // 3) append-only ledger doc referencing the product (ObjectId ref must match).
  const mid = new ObjectId(); const lid = new ObjectId()
  await db1.collection('stockmovements').insertOne({ _id: mid, tenantId: tenantA, productId: pid, locationId: lid, qtyDelta: -1 })
  await wait(2000)
  const mv = await db2.collection('stockmovements').findOne({ _id: mid })
  check('ledger movement synced with productId ref intact', !!mv && String(mv.productId) === String(pid))

  // 3b) stocklevels is DERIVED from the movement on the boss (not LWW-synced).
  check('stocklevels derived on boss ($inc from movement)', ((await db2.collection('stocklevels').findOne({ productId: pid, locationId: lid })) || {}).totalQty === -1)
  // A direct stocklevels write must NOT sync (derived collections are excluded).
  await db1.collection('stocklevels').insertOne({ _id: new ObjectId(), tenantId: tenantA, productId: new ObjectId(), locationId: new ObjectId(), totalQty: 999 })
  await wait(1500)
  check('direct stocklevels write did NOT sync (derived-excluded)', (await db2.collection('stocklevels').countDocuments({ totalQty: 999 })) === 0)

  // 4) other tenant never crosses.
  await db1.collection('products').insertOne({ _id: new ObjectId(), tenantId: tenantB, name: 'SECRET' })
  await wait(1500)
  check('tenant B product did NOT reach boss', (await db2.collection('products').countDocuments({ tenantId: tenantB })) === 0)

  // 5) delete propagates.
  await db1.collection('products').deleteOne({ _id: pid })
  await wait(2000)
  check('delete propagated to boss', (await db2.collection('products').findOne({ _id: pid })) === null)

  await client.close()
  console.log(`\n${failures === 0 ? 'ALL PASSED ✅' : failures + ' FAILED ❌'}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error('fatal:', err); process.exit(1) })
