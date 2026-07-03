#!/usr/bin/env node
'use strict'

/*
 * Nazbu — core.
 *
 * The core knows nothing about HOW peers find each other or connect. It only
 * knows how to sync data once it's handed a "wire" (a duplex stream). That job
 * belongs to a *transport* (see ./transports/). Today: lan-mdns. Tomorrow:
 * softap / wifi-direct / ble — same core, no changes.
 *
 * Shared state = the sum of every node's append-only Hypercore log length.
 * Summing is conflict-free, so it's genuinely multi-writer with zero
 * coordination. Press SPACE on any machine → the TOTAL goes up everywhere.
 *
 * No DHT, no bootstrap server, no internet.
 */

const readline = require('readline')
const Corestore = require('corestore')

// --- pick a transport (this is the only line that changes to go "no-AP") ---
const createTransport = require('./transports/lan-mdns')

const name = process.argv[2] || 'peer-' + process.pid
const store = new Corestore('./.nazbu/' + name)

const cores = new Map() // hexKey -> hypercore
let total = 0

function recompute () {
  let t = 0
  for (const c of cores.values()) t += c.length
  total = t
  render()
}

function render () {
  if (process.env.NAZBU_AUTO) return
  process.stdout.write(
    '\r\x1b[K' +
    `[Nazbu:${name}]  peers:${cores.size}  TOTAL:${total}   (SPACE = +1, q = quit)`
  )
}

async function trackCore (keyHex) {
  if (cores.has(keyHex)) return
  const core = store.get({ key: Buffer.from(keyHex, 'hex') })
  await core.ready()
  cores.set(keyHex, core)
  core.on('append', recompute)
  recompute()
}

function attach (stream, isInitiator) {
  const rep = store.replicate(isInitiator)
  rep.on('error', () => {})
  stream.on('error', () => {})
  rep.pipe(stream).pipe(rep)
}

async function main () {
  const local = store.get({ name: 'local' })
  await local.ready()
  const myKey = local.key.toString('hex')
  cores.set(myKey, local)
  local.on('append', recompute)

  // Wire the transport to the core.
  const transport = createTransport({ myKey })
  transport.events.on('peer-key', trackCore)
  transport.events.on('connection', attach)
  const info = await transport.start()

  console.log(`\n[Nazbu] node "${name}" online via ${transport.name} — no internet needed.`)
  console.log(`[Nazbu] my key: ${myKey.slice(0, 16)}…  listening on :${info.port}\n`)

  if (process.env.NAZBU_AUTO) {
    // headless mode for automated testing: tick + log
    setInterval(() => local.append(Buffer.from([1])), 1500)
    setInterval(() => console.log(`[${name}] peers=${cores.size} total=${total}`), 1000)
    return
  }

  readline.emitKeypressEvents(process.stdin)
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('keypress', async (ch, k) => {
    if (k && (k.name === 'q' || (k.ctrl && k.name === 'c'))) process.exit(0)
    if (k && k.name === 'space') await local.append(Buffer.from([1]))
  })
  render()
}

main().catch(err => {
  console.error('[Nazbu] fatal:', err)
  process.exit(1)
})
