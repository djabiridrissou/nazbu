'use strict'

/*
 * Store adapters for the bridge.
 *
 *  - MockStore:  in-memory, for tests. Proves the bridge end-to-end.
 *  - MongoStore: taps a real MongoDB replica set via change streams. Ready to
 *                point at Womola's `womoladb` — it never changes app code.
 *
 * Change shape exchanged over Nazbu:
 *   { ns: 'products', id: 'PARA', doc: {...} | null(delete), v: <lamport>, by: <node> }
 *
 * Conflicts: last-write-wins by a Lamport version `v`, tie-broken by node name.
 * (Quantity fields like stock should later move to movement/delta events for
 *  conflict-free merges — see the Nazbu README. This is the generic baseline.)
 */

const { EventEmitter } = require('events')

// ---------------------------------------------------------------------------
// MockStore — in-memory, structurally loop-safe: applyRemote() never emits
// 'local', so applied changes are not re-broadcast.
// ---------------------------------------------------------------------------
class MockStore extends EventEmitter {
  constructor (name) {
    super()
    this.name = name
    this.clock = 0
    this.data = new Map() // ns/id -> { doc, v, by }
  }

  _k (ns, id) { return ns + '/' + id }

  // Simulates the app (Womola) writing to the DB — a LOCAL-origin change.
  write (ns, id, doc) {
    this.clock++
    const rec = { doc, v: this.clock, by: this.name }
    this.data.set(this._k(ns, id), rec)
    this.emit('local', { ns, id, doc, v: rec.v, by: this.name })
  }

  delete (ns, id) {
    this.clock++
    this.data.set(this._k(ns, id), { doc: null, v: this.clock, by: this.name })
    this.emit('local', { ns, id, doc: null, v: this.clock, by: this.name })
  }

  get (ns, id) {
    const r = this.data.get(this._k(ns, id))
    return r ? r.doc : undefined
  }

  onLocalChange (cb) { this.on('local', cb) }

  // Apply a peer change with last-write-wins. Does NOT emit 'local'.
  applyRemote (ch) {
    const k = this._k(ch.ns, ch.id)
    const cur = this.data.get(k)
    if (cur && (cur.v > ch.v || (cur.v === ch.v && cur.by >= ch.by))) return false
    this.clock = Math.max(this.clock, ch.v)
    this.data.set(k, { doc: ch.doc, v: ch.v, by: ch.by })
    return true
  }
}

// ---------------------------------------------------------------------------
// MongoStore — real change-stream adapter (needs a replica set: Womola has one).
// Loop prevention: applied-remote writes carry `_nz.by = <origin>`; the watcher
// only broadcasts changes whose `_nz` is absent (a genuine app write) and skips
// anything it (or a peer) stamped.
// ---------------------------------------------------------------------------
class MongoStore {
  constructor ({ db, name, collections }) {
    this.db = db
    this.name = name
    this.collections = collections || null // null = all
    this.clock = 0
    this._stream = null
  }

  onLocalChange (cb) {
    const opts = { fullDocument: 'updateLookup' }
    this._stream = this.db.watch([], opts)
    this._stream.on('change', ev => {
      const ns = ev.ns && ev.ns.coll
      if (this.collections && !this.collections.includes(ns)) return
      const id = ev.documentKey && String(ev.documentKey._id)

      if (ev.operationType === 'delete') {
        cb({ ns, id, doc: null, v: ++this.clock, by: this.name })
        return
      }
      const post = ev.fullDocument
      if (!post) return
      // Only broadcast genuine app writes (no _nz stamp yet). Skip our/peers' echoes.
      if (post._nz) return
      const { _nz, ...doc } = post
      cb({ ns, id, doc, v: ++this.clock, by: this.name })
    })
  }

  applyRemote (ch) {
    this.clock = Math.max(this.clock, ch.v)
    const coll = this.db.collection(ch.ns)
    if (ch.doc === null) {
      return coll.deleteOne({ _id: ch.id }).then(() => true).catch(() => false)
    }
    const doc = { ...ch.doc, _nz: { v: ch.v, by: ch.by } }
    return coll
      .updateOne({ _id: ch.id }, { $set: doc }, { upsert: true })
      .then(() => true)
      .catch(() => false)
  }

  async close () { try { if (this._stream) await this._stream.close() } catch (_) {} }
}

// ---------------------------------------------------------------------------
// Ledger sync — the RIGHT model for Womola stock.
//
// Womola's StockMovement collection is an append-only ledger of signed deltas
// (qtyDelta). Immutable inserts commute, so syncing is conflict-free: replicate
// each movement, dedup by _id, and derive the running level = sum(qtyDelta).
// No last-write-wins, no lost sales; an oversell simply shows as negative.
// ---------------------------------------------------------------------------
class MockLedger extends EventEmitter {
  constructor (name) {
    super()
    this.name = name
    this.movements = new Map() // movementId -> { productId, locationId, qtyDelta }
    this.levels = new Map()    // productId/locationId -> totalQty
  }

  _lk (p, l) { return p + '/' + l }
  level (p, l) { return this.levels.get(this._lk(p, l)) || 0 }
  _applyLevel (p, l, d) { const k = this._lk(p, l); this.levels.set(k, (this.levels.get(k) || 0) + d) }

  // The app (Womola) records a movement — a LOCAL append.
  record (id, productId, locationId, qtyDelta) {
    if (this.movements.has(id)) return
    this.movements.set(id, { productId, locationId, qtyDelta })
    this._applyLevel(productId, locationId, qtyDelta)
    this.emit('local', { ns: 'stockmovements', id, doc: { productId, locationId, qtyDelta } })
  }

  onLocalChange (cb) { this.on('local', cb) }

  // Apply a peer movement. Dedup by id (idempotent) → conflict-free union.
  applyRemote (ch) {
    if (this.movements.has(ch.id)) return false // already have it
    const m = ch.doc
    this.movements.set(ch.id, m)
    this._applyLevel(m.productId, m.locationId, m.qtyDelta)
    return true
  }
}

// Real MongoDB ledger adapter — watches inserts on the movement collection,
// dedups via a SEPARATE `_nazbu_meta` collection (Womola docs untouched), and
// projects each applied movement into StockLevel with a commutative $inc.
class MongoLedgerStore {
  constructor ({ db, name, collection = 'stockmovements', levels = 'stocklevels', meta = '_nazbu_meta' }) {
    this.db = db
    this.name = name
    this.collection = collection
    this.levels = levels
    this.meta = meta
    this._applied = new Set() // ids we just inserted — skip their change events
    this._stream = null
  }

  onLocalChange (cb) {
    this._stream = this.db.watch(
      [{ $match: { 'ns.coll': this.collection, operationType: 'insert' } }],
      { fullDocument: 'updateLookup' }
    )
    this._stream.on('change', ev => {
      const doc = ev.fullDocument
      if (!doc) return
      const id = String(doc._id)
      if (this._applied.has(id)) { this._applied.delete(id); return } // our own applied insert
      cb({
        ns: this.collection,
        id,
        doc: {
          productId: String(doc.productId),
          locationId: String(doc.locationId),
          qtyDelta: doc.qtyDelta,
          type: doc.type,
          tenantId: doc.tenantId ? String(doc.tenantId) : null
        }
      })
    })
  }

  async applyRemote (ch) {
    const { ObjectId } = require('mongodb')
    // Dedup across restarts via our own meta collection (never touches Womola docs).
    const seen = await this.db.collection(this.meta).findOne({ _id: 'mv:' + ch.id })
    if (seen) return false
    this._applied.add(ch.id)
    await this.db.collection(this.meta).insertOne({ _id: 'mv:' + ch.id, at: new Date() })

    const m = ch.doc
    const mvDoc = {
      _id: new ObjectId(ch.id),
      productId: new ObjectId(m.productId),
      locationId: new ObjectId(m.locationId),
      qtyDelta: m.qtyDelta,
      type: m.type || 'other',
      tenantId: m.tenantId ? new ObjectId(m.tenantId) : null,
      createdAt: new Date(),
      updatedAt: new Date()
    }
    await this.db.collection(this.collection).updateOne(
      { _id: mvDoc._id }, { $setOnInsert: mvDoc }, { upsert: true }
    )
    // Derived level: commutative increment, converges everywhere.
    await this.db.collection(this.levels).updateOne(
      { productId: mvDoc.productId, locationId: mvDoc.locationId },
      { $inc: { totalQty: m.qtyDelta, availableQty: m.qtyDelta }, $set: { lastUpdated: new Date() } },
      { upsert: true }
    )
    return true
  }

  async close () { try { if (this._stream) await this._stream.close() } catch (_) {} }
}

module.exports = { MockStore, MongoStore, MockLedger, MongoLedgerStore }
