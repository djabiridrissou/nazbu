'use strict'

/*
 * Nazbu — the library.
 *
 * A tiny, WebSocket-like API for real-time P2P apps on the local network.
 * No server, no internet. Under the hood it's the Hypercore stack + a
 * pluggable LAN transport, but an app never has to know that:
 *
 *     const room = new Nazbu({ name: 'caisse-1' })
 *     room.on('message', (data, meta) => { ... })   // received from a peer
 *     room.on('peers', (count) => { ... })          // peer count changed
 *     await room.start()
 *     room.send({ type: 'sale', total: 4500 })      // broadcast to everyone
 *
 * Messages are durable: they're stored locally and re-sync automatically when
 * peers reconnect — even on a different network. 'message' also fires for your
 * own sends (event-sourcing style), so a fresh peer replays the full history.
 */

const { EventEmitter } = require('events')
const Corestore = require('corestore')
const createTransport = require('./transports/lan-mdns')

class Nazbu extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.name = opts.name || 'peer-' + process.pid
    // A room is the isolation boundary: only nodes in the SAME room discover
    // and sync with each other. Different apps / shops / tenants → different
    // rooms → zero cross-talk, even on the same LAN.
    this.room = opts.room || 'default'
    this.store = new Corestore(opts.storage || './.nazbu-data/' + this.room + '/' + this.name)
    this._createTransport = opts.transport || createTransport
    this.cores = new Map()   // hexKey -> hypercore
    this.cursor = new Map()  // hexKey -> messages already emitted
    this.local = null
    this.key = null
    this.transport = null
  }

  get peers () { return this.cores.size }

  async start () {
    this.local = this.store.get({ name: 'local' })
    await this.local.ready()
    this.key = this.local.key.toString('hex')
    this.cores.set(this.key, this.local)
    this.local.on('append', () => this._drain(this.key, this.local))

    this.transport = this._createTransport({ myKey: this.key, room: this.room })
    this.transport.events.on('peer-key', hex => this._track(hex))
    this.transport.events.on('connection', (stream, isInitiator) => {
      const rep = this.store.replicate(isInitiator)
      rep.on('error', () => {})
      stream.on('error', () => {})
      rep.pipe(stream).pipe(rep)
    })
    await this.transport.start()
    return this
  }

  async send (data) {
    if (!this.local) throw new Error('call start() before send()')
    await this.local.append(Buffer.from(JSON.stringify({ from: this.name, data })))
  }

  async close () {
    try { if (this.transport) this.transport.stop() } catch (_) {}
    try { await this.store.close() } catch (_) {}
  }

  async _track (hex) {
    if (this.cores.has(hex)) return
    const core = this.store.get({ key: Buffer.from(hex, 'hex') })
    await core.ready()
    this.cores.set(hex, core)
    core.on('append', () => this._drain(hex, core))
    this.emit('peers', this.peers)
    core.update().then(() => this._drain(hex, core)).catch(() => {})
  }

  async _drain (hex, core) {
    const from = this.cursor.get(hex) || 0
    for (let i = from; i < core.length; i++) {
      try {
        const env = JSON.parse((await core.get(i)).toString())
        this.emit('message', env.data, { from: env.from, key: hex, seq: i })
      } catch (_) {}
    }
    this.cursor.set(hex, core.length)
  }
}

module.exports = Nazbu
module.exports.Nazbu = Nazbu
