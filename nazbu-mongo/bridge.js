'use strict'

/*
 * NazbuMongoBridge — the non-invasive sidecar.
 *
 * It sits BESIDE an app (e.g. Womola) and mirrors a database across machines
 * over Nazbu, without the app knowing it exists:
 *
 *   local DB change  ──► Nazbu event ──► peers ──► apply to their local DB
 *
 * The bridge itself is storage-agnostic. It talks to a small "store adapter"
 * (see stores.js: MockStore for tests, MongoStore for real Womola) with just:
 *
 *   store.onLocalChange(cb)   cb({ ns, id, doc|null, v, by }) for LOCAL writes
 *   store.applyRemote(change) apply a peer's change with last-write-wins
 *
 * Loop prevention lives in the store: applyRemote() must NOT re-fire
 * onLocalChange, otherwise an applied change would bounce back forever.
 */

class NazbuMongoBridge {
  constructor ({ store, nazbu }) {
    this.store = store
    this.nazbu = nazbu
    this.applied = 0
    this.sent = 0
  }

  async start () {
    // Peer change → apply locally (last-write-wins is decided by the store).
    this.nazbu.on('message', (change, meta) => {
      if (meta.from === this.nazbu.name) return // ignore our own echo
      const changed = this.store.applyRemote(change)
      if (changed) this.applied++
    })

    await this.nazbu.start()

    // Local write → broadcast to every peer in the room.
    this.store.onLocalChange(change => {
      this.sent++
      this.nazbu.send(change)
    })

    return this
  }
}

module.exports = NazbuMongoBridge
