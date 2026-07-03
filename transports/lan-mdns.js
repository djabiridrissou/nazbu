'use strict'

/*
 * Transport: LAN + mDNS  (Nazbu transport #1)
 *
 * Discovers peers on the local network via mDNS and connects over plain TCP.
 * Needs a shared access point / Wi-Fi, but NO internet.
 *
 * Resilient to network drops and app restarts: it keeps re-scanning the LAN
 * and re-dials any peer whose link is down (Wi-Fi came back, peer restarted on
 * a new port, etc.). Once a fresh link is up, Hypercore replication catches up
 * automatically.
 *
 * Emits:
 *   events.emit('peer-key', hexKey)                a peer's core key was learned
 *   events.emit('connection', duplexStream, init)  a raw wire to replicate over
 */

const net = require('net')
const { EventEmitter } = require('events')
const { Bonjour } = require('bonjour-service')

const SERVICE_TYPE = 'nazbu'
const RETRY_MS = 3000

module.exports = function lanMdns ({ myKey }) {
  const events = new EventEmitter()
  const peers = new Map() // peerKey -> { host, port, connected }
  let server = null
  let bonjour = null
  let browser = null
  let timer = null

  // Only the lower key dials → exactly one link per pair.
  function dialPeer (peerKey) {
    if (myKey >= peerKey) return
    const p = peers.get(peerKey)
    if (!p || p.connected) return

    p.connected = true // optimistic; cleared if the socket dies
    const socket = net.connect(p.port, p.host)
    socket.setKeepAlive(true, 5000)

    const down = () => { p.connected = false }
    socket.on('connect', () => events.emit('connection', socket, true))
    socket.on('error', down)
    socket.on('close', down)
  }

  function onService (service) {
    const peerKey = service.txt && service.txt.key
    if (!peerKey || peerKey === myKey) return
    const host =
      (service.referer && service.referer.address) ||
      (service.addresses && service.addresses[0])
    if (!host) return

    const existing = peers.get(peerKey)
    if (existing) {
      // Peer restarted on a new port → the old link is stale, force a re-dial.
      if (existing.port !== service.port) existing.connected = false
      existing.host = host
      existing.port = service.port
    } else {
      peers.set(peerKey, { host, port: service.port, connected: false })
    }

    events.emit('peer-key', peerKey)
    dialPeer(peerKey)
  }

  async function start () {
    // Accept connections from any peer that dials us.
    server = net.createServer(socket => {
      socket.setKeepAlive(true, 5000)
      socket.on('error', () => {})
      events.emit('connection', socket, false)
    })
    await new Promise(res => server.listen(0, res))
    const port = server.address().port

    // Announce ourselves + browse for peers on the LAN.
    bonjour = new Bonjour()
    bonjour.publish({
      name: 'nazbu-' + myKey.slice(0, 8),
      type: SERVICE_TYPE,
      port,
      txt: { key: myKey }
    })

    browser = bonjour.find({ type: SERVICE_TYPE })
    browser.on('up', onService)
    browser.on('down', service => {
      const peerKey = service.txt && service.txt.key
      const p = peerKey && peers.get(peerKey)
      if (p) p.connected = false
    })

    // Heartbeat: re-query mDNS + re-dial any peer whose link is down.
    // This is what makes reconnection automatic after a Wi-Fi drop/change.
    timer = setInterval(() => {
      try { browser.update() } catch (_) {}
      for (const key of peers.keys()) dialPeer(key)
    }, RETRY_MS)
    if (timer.unref) timer.unref()

    return { port }
  }

  function stop () {
    if (timer) clearInterval(timer)
    try { if (browser) browser.stop() } catch (_) {}
    try { if (bonjour) bonjour.destroy() } catch (_) {}
    try { if (server) server.close() } catch (_) {}
  }

  return { name: 'lan-mdns', events, start, stop }
}
