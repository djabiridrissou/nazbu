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
const createLanMdns = require('./transports/lan-mdns')
const createInternetSwarm = require('./transports/internet-swarm')

class Nazbu extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.name = opts.name || 'peer-' + process.pid
    // A room is the isolation boundary: only nodes in the SAME room discover
    // and sync with each other. Different apps / shops / tenants → different
    // rooms → zero cross-talk, even on the same LAN.
    this.room = opts.room || 'default'
    this.store = new Corestore(opts.storage || './.nazbu-data/' + this.room + '/' + this.name)
    // Transports connect peers. LAN (mDNS) by default; add internet (Hyperswarm)
    // for the offline-shop → online-boss leg. `opts.transports` overrides fully.
    this._transportFactories = opts.transports ||
      (opts.transport ? [opts.transport]
        : [createLanMdns, ...(opts.internet ? [createInternetSwarm] : [])])
    this.transports = []
    this.cores = new Map()   // hexKey -> hypercore
    this.cursor = new Map()  // hexKey -> messages already emitted
    this.names = new Map()   // hexKey -> friendly name (learned via presence)
    this.local = null
    this.key = null

    // Database-sync mode: `new Nazbu({ db, room, policies })`. When `db` is a pg
    // Pool or a mongodb Db, Nazbu wires the matching adapter automatically and
    // keeps that database synced across every peer in the room — no app change.
    this._db = opts.db || null
    this._dbConf = {
      policies: opts.policies || {},
      tables: opts.tables || null,
      exclude: opts.exclude || [],
      tenantId: opts.tenantId || null,
      ledger: opts.ledger || null
    }
    this._dbStore = null
    this.applied = 0   // peer changes written into the local DB
    this.sent = 0      // local changes broadcast to peers
  }

  // Discovered peers (seen via mDNS) — NOT necessarily connected.
  get peers () { return this.cores.size }

  // Actually-connected replication links. If peers > 0 but links == 0, the
  // machines see each other but the TCP link is blocked (firewall / AP isolation).
  get links () { return (this.local && this.local.peers) ? this.local.peers.length : 0 }

  async start () {
    this.local = this.store.get({ name: 'local' })
    await this.local.ready()
    this.key = this.local.key.toString('hex')
    this.names.set(this.key, this.name)
    this.cores.set(this.key, this.local)
    this.local.on('append', () => this._drain(this.key, this.local))
    // Real connection health: fires when a replication link opens/closes.
    const emitLink = () => this.emit('link', this.links)
    this.local.on('peer-add', emitLink)
    this.local.on('peer-remove', emitLink)

    // DB mode: set up the adapter (create triggers/tables, open the stream) and
    // attach the apply handler BEFORE replication starts, so the DB infra is
    // ready and a peer's history is written locally as it streams in.
    if (this._db) {
      const { resolveStore } = require('./adapters')
      this._dbStore = resolveStore(this._db, { name: this.name, ...this._dbConf })
      if (typeof this._dbStore.start === 'function') await this._dbStore.start()
      this.on('message', (change, meta) => {
        if (!change || (meta && meta.from === this.name)) return
        Promise.resolve(this._dbStore.applyRemote(change))
          .then(ok => { if (ok) this.applied++ })
          .catch(() => {})
      })
    }

    for (const factory of this._transportFactories) {
      const transport = factory({ myKey: this.key, room: this.room })
      transport.events.on('peer-key', hex => this._track(hex))
      transport.events.on('connection', (stream, isInitiator) => {
        const rep = this.store.replicate(isInitiator)
        rep.on('error', () => {})
        stream.on('error', () => {})
        rep.pipe(stream).pipe(rep)
      })
      this.transports.push(transport)
    }
    await Promise.all(this.transports.map(t => t.start()))

    // DB mode: start capturing local writes AFTER the core + transports are up
    // (mirrors the proven bridge ordering — apply first, then broadcast).
    if (this._dbStore) {
      this._dbStore.onLocalChange(change => { this.sent++; this.send(change) })
    }
    return this
  }

  async send (data) {
    if (!this.local) throw new Error('call start() before send()')
    await this.local.append(Buffer.from(JSON.stringify({ from: this.name, data })))
  }

  // Presence ping so peers can map key -> name. Internal; not an app message.
  async _hello () {
    if (!this.local) return
    try {
      await this.local.append(Buffer.from(JSON.stringify({ from: this.name, hello: true })))
    } catch (_) {}
  }

  // Live view of the network: who's here and who's actually connected.
  map () {
    const rows = []
    for (const [hex, core] of this.cores) {
      const self = hex === this.key
      rows.push({
        key: hex.slice(0, 8),
        name: this.names.get(hex) || (self ? this.name : '—'),
        self,
        linked: self ? this.links > 0 : !!(core.peers && core.peers.length)
      })
    }
    return rows
  }

  async close () {
    for (const t of this.transports) { try { t.stop() } catch (_) {} }
    try { if (this._dbStore) await this._dbStore.close() } catch (_) {}
    try { await this.store.close() } catch (_) {}
  }

  async _track (hex) {
    if (this.cores.has(hex)) return
    const core = this.store.get({ key: Buffer.from(hex, 'hex') })
    await core.ready()
    this.cores.set(hex, core)
    core.on('append', () => this._drain(hex, core))
    this.emit('peers', this.peers)
    this._hello() // let this new peer learn our name
    core.update().then(() => this._drain(hex, core)).catch(() => {})
  }

  async _drain (hex, core) {
    const from = this.cursor.get(hex) || 0
    for (let i = from; i < core.length; i++) {
      try {
        const env = JSON.parse((await core.get(i)).toString())
        if (env && env.from) this.names.set(hex, env.from)
        if (env && env.hello) continue // presence, not an app message
        this.emit('message', env.data, { from: env.from, key: hex, seq: i })
      } catch (_) {}
    }
    this.cursor.set(hex, core.length)
  }
}

module.exports = Nazbu
module.exports.Nazbu = Nazbu
