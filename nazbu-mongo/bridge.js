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
    // Some stores need one-time setup (create triggers/tables, open a stream).
    // Do it BEFORE anything can apply, so the infra is ready. Mongo stores that
    // set up lazily in onLocalChange simply have no start() → skipped.
    if (typeof this.store.start === 'function') await this.store.start()

    // Peer change → apply locally (last-write-wins is decided by the store).
    this.nazbu.on('message', (change, meta) => {
      if (meta.from === this.nazbu.name) return // ignore our own echo
      Promise.resolve(this.store.applyRemote(change))
        .then(changed => { if (changed) this.applied++ })
        .catch(() => {})
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
