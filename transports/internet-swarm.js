'use strict'

/*
 * Transport: Internet + Hyperswarm/DHT  (Nazbu transport #2)
 *
 * Connects peers over the INTERNET via the Hyperswarm DHT (holepunching), for
 * the "offline shop → online boss" leg: when the shop gets a few minutes of
 * internet, its hub reaches the boss's cloud node and syncs.
 *
 * Same contract as the LAN transport:
 *   events.emit('peer-key', hexKey)                a peer's core key was learned
 *   events.emit('connection', duplexStream, init)  a wire to replicate over
 *
 * All nodes in the same `room` join the same DHT topic and find each other.
 * Hyperswarm gives us encrypted streams keyed by DHT identity, so we do a tiny
 * one-line handshake to swap Hypercore keys before replicating.
 */

const crypto = require('crypto')
const { EventEmitter } = require('events')
const { Duplex } = require('streamx')
const Hyperswarm = require('hyperswarm')

module.exports = function internetSwarm ({ myKey, room = 'default' }) {
  const events = new EventEmitter()
  let swarm = null

  const topic = crypto.createHash('sha256').update('nazbu:' + room).digest() // 32 bytes

  function onConnection (conn) {
    conn.on('error', () => {})
    conn.write(Buffer.from(myKey + '\n')) // announce our key first

    let buf = Buffer.alloc(0)
    let done = false
    const onData = chunk => {
      if (done) return
      buf = Buffer.concat([buf, chunk])
      const nl = buf.indexOf(0x0a)
      if (nl === -1) return
      done = true
      conn.removeListener('data', onData)

      const peerKey = buf.slice(0, nl).toString('utf8').trim()
      const rest = buf.slice(nl + 1)
      if (!peerKey || peerKey === myKey) { try { conn.destroy() } catch (_) {}; return }

      // Wrap the connection so the leftover replication bytes (received during
      // the handshake) are delivered before the rest of the stream.
      const wire = new Duplex({
        write (data, cb) { conn.write(data); cb() },
        final (cb) { try { conn.end() } catch (_) {} cb() }
      })
      if (rest.length) wire.push(rest)
      conn.on('data', c => wire.push(c))
      conn.on('end', () => wire.push(null))
      conn.on('error', () => wire.destroy())
      wire.on('error', () => { try { conn.destroy() } catch (_) {} })

      events.emit('peer-key', peerKey)
      events.emit('connection', wire, !!conn.isInitiator)
    }
    conn.on('data', onData)
  }

  async function start () {
    swarm = new Hyperswarm()
    swarm.on('connection', onConnection)
    const discovery = swarm.join(topic, { server: true, client: true })
    await discovery.flushed().catch(() => {})
    return { topic: topic.toString('hex').slice(0, 8) }
  }

  function stop () {
    try { if (swarm) swarm.destroy() } catch (_) {}
  }

  return { name: 'internet-swarm', events, start, stop }
}
