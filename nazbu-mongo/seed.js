#!/usr/bin/env node
'use strict'

/*
 * Seed a shop with a tenant's data slice — the initial load before live sync.
 *
 *   # on the boss: export one tenant's whole slice
 *   node seed.js export --tenant <tenantId> --uri "<boss-mongo-uri>" --db womoladb --out ./seed
 *
 *   # in the shop: load it into the local Mongo
 *   node seed.js import --uri "<shop-mongo-uri>" --db womoladb --in ./seed
 *
 * EJSON is used so ObjectId/Date/Decimal128 survive intact (references keep
 * matching). Import is idempotent (upsert by _id) so re-seeding is safe.
 */

const fs = require('fs')
const path = require('path')
const { MongoClient } = require('mongodb')
const { EJSON, ObjectId } = require('bson')

function arg (n, d) {
  const i = process.argv.indexOf('--' + n)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return process.env['NAZBU_' + n.toUpperCase()] || d
}

async function exportTenant () {
  const uri = arg('uri'); const dbName = arg('db', 'womoladb')
  const tenant = arg('tenant'); const out = arg('out', './seed')
  if (!uri || !tenant) { console.error('need --uri and --tenant'); process.exit(1) }
  fs.mkdirSync(out, { recursive: true })

  const client = await new MongoClient(uri).connect()
  const db = client.db(dbName)
  let tOid = tenant; try { tOid = new ObjectId(tenant) } catch (_) {}
  const query = { $or: [{ tenantId: tOid }, { tenantId: tenant }] }

  const colls = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map(c => c.name).filter(n => !n.startsWith('_nazbu') && !n.startsWith('system.'))

  const manifest = { tenant, db: dbName, collections: {} }
  for (const c of colls) {
    const docs = await db.collection(c).find(query).toArray()
    if (!docs.length) continue
    fs.writeFileSync(path.join(out, c + '.ejson'), EJSON.stringify(docs))
    manifest.collections[c] = docs.length
  }

  // The shop needs its OWN tenant record (in the tenants collection, keyed by _id).
  const own = await db.collection('tenants').find({ _id: tOid }).toArray()
  if (own.length) {
    fs.writeFileSync(path.join(out, 'tenants.ejson'), EJSON.stringify(own))
    manifest.collections.tenants = own.length
  }

  // Global lookup collections have no tenantId (shared) — seed them whole, once.
  // They're read-only reference data; the tenant-scoped sidecar won't sync them.
  const globals = (arg('globals', '')).split(',').map(s => s.trim()).filter(Boolean)
  for (const g of globals) {
    const docs = await db.collection(g).find({}).toArray()
    if (!docs.length) continue
    fs.writeFileSync(path.join(out, g + '.ejson'), EJSON.stringify(docs))
    manifest.collections[g] = docs.length
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await client.close()
  const totalDocs = Object.values(manifest.collections).reduce((a, b) => a + b, 0)
  console.log(`exported tenant ${tenant}: ${Object.keys(manifest.collections).length} collections, ${totalDocs} docs → ${out}`)
}

async function importTenant () {
  const uri = arg('uri'); const dbName = arg('db', 'womoladb'); const inp = arg('in', './seed')
  if (!uri) { console.error('need --uri'); process.exit(1) }
  const client = await new MongoClient(uri).connect()
  const db = client.db(dbName)
  const files = fs.readdirSync(inp).filter(f => f.endsWith('.ejson'))
  let total = 0
  for (const f of files) {
    const coll = f.replace(/\.ejson$/, '')
    const docs = EJSON.parse(fs.readFileSync(path.join(inp, f), 'utf8'))
    if (!docs.length) continue
    await db.collection(coll).bulkWrite(
      docs.map(d => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })),
      { ordered: false }
    )
    total += docs.length
    console.log(`  ${coll}: ${docs.length}`)
  }
  await client.close()
  console.log(`imported ${total} docs from ${inp}`)
}

const cmd = process.argv[2]
;(async () => {
  if (cmd === 'export') await exportTenant()
  else if (cmd === 'import') await importTenant()
  else { console.log('usage: node seed.js export|import --uri <uri> [--tenant <id>] [--db womoladb] [--out|--in <dir>]'); process.exit(1) }
})().catch(e => { console.error('fatal:', e.message); process.exit(1) })
