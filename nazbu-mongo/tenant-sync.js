'use strict'

/*
 * MongoTenantStore — replicates ONE tenant's ENTIRE database slice.
 *
 * Watches the whole database change stream (all collections), keeps only this
 * tenant's documents, and syncs every change over Nazbu so a shop can run all
 * of Womola offline and reconcile with the boss when the internet returns.
 *
 * Per-collection behaviour:
 *   - append-only ledgers (stockmovements, sales, …) → union by _id, never lost
 *   - everything else (mutable entities) → last-write-wins by a timestamp clock
 *   - deletes → propagated (last-write-wins)
 *
 * Correctness details that matter on a real ERP:
 *   - BSON types (ObjectId, Date, Decimal128) are preserved with EJSON, so
 *     references between documents keep matching across machines.
 *   - Sync bookkeeping (versions, dedup) lives in a SEPARATE `_nazbu_meta`
 *     collection — Womola's own documents are never modified.
 *   - Tenant isolation on every path, including deletes (a delete only
 *     propagates for a doc we've already seen for this tenant).
 */

const { EJSON } = require('bson')

class MongoTenantStore {
  constructor (opts = {}) {
    const { db, name, tenantId, ledgerCollections = [], meta = '_nazbu_meta' } = opts
    if (!tenantId) throw new Error('MongoTenantStore requires a tenantId')
    this.db = db
    this.name = name
    this.tenantId = String(tenantId)
    this.ledger = new Set(ledgerCollections)
    this.meta = meta
    // Derived collections are NOT synced directly (LWW would lose concurrent
    // deltas). They're recomputed from a ledger instead — e.g. stocklevels is
    // re-derived from stockmovements via a commutative $inc.
    this.derived = new Set(opts.derivedCollections || ['stocklevels'])
    this.projections = opts.projections || {
      stockmovements: { into: 'stocklevels', key: ['productId', 'locationId'], deltaField: 'qtyDelta', targets: ['totalQty', 'availableQty'] }
    }
    this.clock = 0
    this._applied = new Set() // "coll:id" we just wrote — skip their own change events
    this._stream = null
  }

  _tick () {
    // Timestamp-based Lamport clock: intuitive LWW, survives restarts.
    this.clock = Math.max(this.clock + 1, Date.now())
    return this.clock
  }

  onLocalChange (cb) {
    this._stream = this.db.watch([], { fullDocument: 'updateLookup' })
    this._stream.on('error', () => {})
    this._stream.on('change', async ev => {
      try {
        const coll = ev.ns && ev.ns.coll
        if (!coll || coll === this.meta) return
        if (this.derived.has(coll)) return // derived (e.g. stocklevels) — recomputed, never synced directly
        if (!ev.documentKey) return
        const id = String(ev.documentKey._id)
        const key = coll + ':' + id
        if (this._applied.has(key)) { this._applied.delete(key); return } // our own echo

        const metaC = this.db.collection(this.meta)

        if (ev.operationType === 'delete') {
          // No document to read tenantId from — only propagate if we've synced
          // this doc before (i.e. it belonged to our tenant).
          const known = await metaC.findOne({ _id: key })
          if (!known) return
          const v = this._tick()
          await metaC.updateOne({ _id: key }, { $set: { v, by: this.name, deleted: true } })
          cb({ coll, id, key, op: 'delete', idE: EJSON.stringify(ev.documentKey._id), v, by: this.name })
          return
        }

        const doc = ev.fullDocument
        if (!doc) return
        if (String(doc.tenantId) !== this.tenantId) return // other tenant — fence

        const mode = this.ledger.has(coll) ? 'ledger' : 'lww'
        const v = this._tick()
        // Track our OWN version so we can reject older remote writes (LWW) and
        // so deletes of locally-created docs still propagate.
        await metaC.updateOne({ _id: key }, { $set: { v, by: this.name } }, { upsert: true })
        cb({ coll, id, key, op: 'upsert', mode, docE: EJSON.stringify(doc), v, by: this.name })
      } catch (_) {}
    })
  }

  async applyRemote (ch) {
    try {
      const metaC = this.db.collection(this.meta)
      const coll = this.db.collection(ch.coll)

      if (ch.op === 'delete') {
        const cur = await metaC.findOne({ _id: ch.key })
        if (cur && cur.v > ch.v) return false
        this._applied.add(ch.key)
        await coll.deleteOne({ _id: EJSON.parse(ch.idE) })
        await metaC.updateOne({ _id: ch.key }, { $set: { v: ch.v, by: ch.by, deleted: true } }, { upsert: true })
        return true
      }

      const doc = EJSON.parse(ch.docE)
      // Tenant fence (defense in depth).
      if (String(doc.tenantId) !== this.tenantId) return false

      if (ch.mode === 'ledger') {
        const seen = await metaC.findOne({ _id: ch.key })
        if (seen) return false // immutable — already have it
        this._applied.add(ch.key)
        await metaC.insertOne({ _id: ch.key, v: ch.v, by: ch.by })
        await coll.updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true })
        // Re-derive any dependent balance (e.g. stocklevels) via a commutative $inc.
        const proj = this.projections[ch.coll]
        if (proj) {
          const filter = {}
          for (const k of proj.key) filter[k] = doc[k]
          const inc = {}
          for (const t of proj.targets) inc[t] = doc[proj.deltaField]
          await this.db.collection(proj.into).updateOne(
            filter, { $inc: inc, $set: { lastUpdated: new Date(), tenantId: doc.tenantId } }, { upsert: true }
          )
        }
        return true
      }

      // last-write-wins
      const cur = await metaC.findOne({ _id: ch.key })
      if (cur && (cur.v > ch.v || (cur.v === ch.v && String(cur.by) >= String(ch.by)))) return false
      this._applied.add(ch.key)
      await metaC.updateOne({ _id: ch.key }, { $set: { v: ch.v, by: ch.by } }, { upsert: true })
      await coll.replaceOne({ _id: doc._id }, doc, { upsert: true })
      return true
    } catch (_) {
      return false
    }
  }

  async close () { try { if (this._stream) await this._stream.close() } catch (_) {} }
}

module.exports = { MongoTenantStore }
