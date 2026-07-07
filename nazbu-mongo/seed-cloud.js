#!/usr/bin/env node
'use strict'

/*
 * Initial data load for a fresh shop server — pull this tenant's slice from the
 * cloud over HTTPS and upsert it into the LOCAL Mongo, before live sync starts.
 *
 * The shop can't reach the cloud Mongo directly (multi-tenant safety), so it
 * calls the licence-gated export API instead:
 *
 *   POST <base>/api/license/tenant-export   Authorization: Bearer <licenceKey>
 *     → streams NDJSON: a {"__col":"<name>"} marker then one EJSON doc per line.
 *
 * Env:
 *   NAZBU_URI        local mongo uri (mongodb://127.0.0.1:27017/womoladb?directConnection=true)
 *   NAZBU_DB         db name (womoladb)
 *   WOMOLA_BASE      cloud base url (https://womola.com)
 *   LICENSE_TOKEN    the licence key (JWT)  — OR LICENSE_TOKEN_PATH to a file
 *
 * Idempotent: upsert by _id, so a re-run only reconciles. But the caller should
 * gate it to first-run so offline edits are never clobbered by cloud versions.
 */

const fs = require('fs')
const { MongoClient } = require('mongodb')
const { EJSON } = require('bson')

const URI = process.env.NAZBU_URI || 'mongodb://127.0.0.1:27017/womoladb?directConnection=true'
const DB = process.env.NAZBU_DB || 'womoladb'
const BASE = (process.env.WOMOLA_BASE || 'https://womola.com').replace(/\/+$/, '')
const TOKEN = (process.env.LICENSE_TOKEN ||
  (process.env.LICENSE_TOKEN_PATH && fs.existsSync(process.env.LICENSE_TOKEN_PATH)
    ? fs.readFileSync(process.env.LICENSE_TOKEN_PATH, 'utf8').trim() : '') || '').trim()

const BATCH = 500

async function main () {
  if (!TOKEN) throw new Error('LICENSE_TOKEN (or LICENSE_TOKEN_PATH) is required')

  const url = `${BASE}/api/license/tenant-export`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`export API ${res.status}: ${body.slice(0, 200)}`)
  }

  const client = await new MongoClient(URI).connect()
  const db = client.db(DB)

  let current = null       // collection name being loaded
  let batch = []           // buffered docs for `current`
  let total = 0
  let tenantName = ''

  async function flush () {
    if (!current || !batch.length) { batch = []; return }
    await db.collection(current).bulkWrite(
      batch.map(d => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })),
      { ordered: false }
    )
    total += batch.length
    batch = []
  }

  async function handleLine (line) {
    if (!line) return
    let obj
    try { obj = EJSON.parse(line) } catch { return }
    if (obj.__meta) { tenantName = obj.__meta.tenantName || ''; return }
    if (obj.__done) { await flush(); return }
    if (obj.__col) { await flush(); current = obj.__col; return }
    if (!current) return
    batch.push(obj)
    if (batch.length >= BATCH) await flush()
  }

  // Stream the NDJSON body line by line (never buffer the whole slice).
  let buf = ''
  const decoder = new TextDecoder()
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      await handleLine(line)
    }
  }
  if (buf.trim()) await handleLine(buf.trim())
  await flush()

  await client.close()
  console.log(`seed-cloud: imported ${total} docs${tenantName ? ` for ${tenantName}` : ''}`)
}

main().catch(e => { console.error('seed-cloud fatal:', e.message); process.exit(1) })
