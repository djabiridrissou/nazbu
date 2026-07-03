'use strict'

/*
 * Transport: LAN + mDNS  (Nazbu transport #1)
 *
 * Discovers peers on the local network via mDNS (link-local multicast) and
 * connects to them over plain TCP. Needs a shared access point / Wi-Fi, but
 * NO internet.
 *
 * A Nazbu transport is dead simple — it just has to emit two things:
 *   events.emit('peer-key', hexKey)              a peer's core key was learned
 *   events.emit('connection', duplexStream, init) a raw wire to replicate over
 *
 * The Nazbu core does the rest (Hypercore replication). Swap this file for
 * softap.js / wifi-direct.js / ble.js to connect peers WITHOUT an access point
 * later — the core never changes.
 */

const net = require('net')
const { EventEmitter } = require('events')
const { Bonjour } = require('bonjour-service')

const SERVICE_TYPE = 'nazbu'

module.exports = function lanMdns ({ myKey }) {
  const events = new EventEmitter()
  const dialed = new Set()
  let server = null
  let bonjour = null

  async function start () {
    // Accept connections from any peer that dials us.
    server = net.createServer(socket => {
      socket.on('error', () => {})
      events.emit('connection', socket, false)
    })
    await new Promise(res => server.listen(0, res))
    const port = server.address().port

    // Announce ourselves + listen for peers on the LAN.
    bonjour = new Bonjour()
    bonjour.publish({
      name: 'nazbu-' + myKey.slice(0, 8),
      type: SERVICE_TYPE,
      port,
      txt: { key: myKey }
    })

    bonjour.find({ type: SERVICE_TYPE }, service => {
      const peerKey = service.txt && service.txt.key
      if (!peerKey || peerKey === myKey) return

      events.emit('peer-key', peerKey)

      // Dedupe: only the lower key dials → one link per pair.
      if (myKey < peerKey && !dialed.has(peerKey)) {
        const host =
          (service.referer && service.referer.address) ||
          (service.addresses && service.addresses[0])
        if (!host) return
        dialed.add(peerKey)
        const socket = net.connect(service.port, host, () =>
          events.emit('connection', socket, true)
        )
        socket.on('error', () => dialed.delete(peerKey))
      }
    })

    return { port }
  }

  function stop () {
    try { if (bonjour) bonjour.destroy() } catch (_) {}
    try { if (server) server.close() } catch (_) {}
  }

  return { name: 'lan-mdns', events, start, stop }
}
