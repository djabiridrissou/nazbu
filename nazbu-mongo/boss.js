#!/usr/bin/env node
'use strict'

/*
 * boss.js — the single, DYNAMIC, multi-tenant Nazbu boss for the CLOUD.
 *
 * Runs ONCE on the cloud (womola.com VPS), 24/7. It discovers which tenants have
 * an active offline licence and runs a Nazbu tenant-sync (room `tenant-<id>`, over
 * the internet/DHT) for EACH — all connected to the CLOUD Mongo. It re-scans on an
 * interval, so:
 *   • a NEW client that installs Womola Server + gets a licence is picked up
 *     automatically (no per-client setup on the VPS),
 *   • a tenant whose licence is terminated/revoked is dropped automatically.
 *
 * The only per-client action is issuing the licence (already a 1-click super-admin
 * step). Everything else scales itself.
 *
 * Env:
 *   NAZBU_URI     cloud mongo uri (with ?replicaSet=… or ?directConnection=true)
 *   NAZBU_DB      db name (default womoladb)
 *   BOSS_SCAN_MS  re-scan interval ms (default 120000)
 *   BOSS_TENANTS  optional comma-separated tenantIds — forces this exact set
 *                 (skips licence discovery; handy for testing)
 *   NAZBU_LEDGER  append-only collections (union sync); rest is last-write-wins
 *
 * NOTE on scale: each tenant sync opens its own whole-DB change stream and filters
 * to its tenant. That's fine for tens of shops. For hundreds, switch to a single
 * shared change stream fanned out per tenant (left as a future optimisation).
 */

const { MongoClient } = require('mongodb')
let Nazbu; try { Nazbu = require('nazbu') } catch (_) { Nazbu = require('../index') }
const Bridge = require('./bridge')
const { MongoTenantStore } = require('./tenant-sync')

const URI = process.env.NAZBU_URI || 'mongodb://127.0.0.1:27017/?replicaSet=rs0'
const DB = process.env.NAZBU_DB || 'womoladb'
const SCAN_MS = Number(process.env.BOSS_SCAN_MS || 120000)
const FORCED = (process.env.BOSS_TENANTS || '').split(',').map(s => s.trim()).filter(Boolean)
// Ledger = insert-only/union. ONLY stockmovements needs it (append-only + drives
// the stocklevels projection). Every other collection is mutated in place by the
// app, and ledger mode treats docs as immutable → updates would never sync. So
// everything else is last-write-wins (propagates updates). Keep this minimal.
const LEDGER = (process.env.NAZBU_LEDGER || 'stockmovements')
  .split(',').map(s => s.trim()).filter(Boolean)

const running = new Map() // tenantId -> { store, nazbu, bridge }

// Which tenants should the boss serve? Those whose LATEST licence event is not a
// termination/revocation. (A re-issued licence flips them back to active.)
async function discover (db) {
  if (FORCED.length) return FORCED
  const rows = await db.collection('licenseevents').aggregate([
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$tenantId', type: { $first: '$type' } } },
    { $match: { type: { $nin: ['terminated', 'revoked'] } } },
  ]).toArray()
  return rows.map(r => r._id && String(r._id)).filter(Boolean)
}

async function startTenant (db, tenantId) {
  const name = 'boss-' + tenantId.slice(-6)
  const room = 'tenant-' + tenantId
  const store = new MongoTenantStore({ db, name, tenantId, ledgerCollections: LEDGER })
  const nazbu = new Nazbu({ name, room, internet: true })
  const bridge = new Bridge({ store, nazbu })
  await bridge.start()
  running.set(tenantId, { store, nazbu, bridge })
  console.log(`[boss] + tenant ${tenantId}  →  room "${room}"`)
}

async function stopTenant (tenantId) {
  const r = running.get(tenantId)
  if (!r) return
  try { await r.nazbu.close() } catch (_) {}
  try { await r.store.close() } catch (_) {}
  running.delete(tenantId)
  console.log(`[boss] - tenant ${tenantId} (licence ended)`)
}

async function scan (db) {
  let active
  try { active = await discover(db) } catch (e) { console.error('[boss] discover failed:', e.message); return }
  const want = new Set(active)
  for (const t of want) {
    if (!running.has(t)) { try { await startTenant(db, t) } catch (e) { console.error('[boss] start ' + t + ':', e.message) } }
  }
  for (const t of [...running.keys()]) {
    if (!want.has(t)) await stopTenant(t)
  }
}

async function main () {
  const client = await new MongoClient(URI).connect()
  const db = client.db(DB)
  console.log(`[boss] cloud boss up — db "${DB}", re-scan every ${SCAN_MS / 1000}s${FORCED.length ? ' (forced: ' + FORCED.join(',') + ')' : ''}`)
  await scan(db)
  const scanIv = setInterval(() => scan(db).catch(e => console.error('[boss] scan:', e.message)), SCAN_MS)

  const beatIv = setInterval(() => {
    const parts = [...running.entries()].map(([t, r]) => `${t.slice(-6)}:${r.nazbu.links}↔`)
    console.log(`[boss] tenants:${running.size}  ${parts.join(' ')}`)
  }, 10000)

  const shutdown = async () => {
    clearInterval(scanIv); clearInterval(beatIv)
    for (const t of [...running.keys()]) await stopTenant(t)
    try { await client.close() } catch (_) {}
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(e => { console.error('[boss] fatal:', e.message); process.exit(1) })
