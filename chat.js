#!/usr/bin/env node
'use strict'

/*
 * Nazbu chat — Phase 1 demo.
 *
 * Same architecture as the counter, but now syncing REAL data (text messages)
 * instead of a number. This is the proof that Nazbu can back a real app:
 *   - each node appends its messages to its own Hypercore log
 *   - every node replicates every other node's log (over the LAN transport)
 *   - each node reads all logs and prints the messages
 *
 * No server, no internet. Run it on two machines on the same Wi-Fi and chat.
 *
 *   node chat.js alice      # machine 1
 *   node chat.js bob        # machine 2
 */

const readline = require('readline')
const Corestore = require('corestore')
const createTransport = require('./transports/lan-mdns')

const name = process.argv[2] || 'me'
const store = new Corestore('./.nazbu-chat/' + name)

const cores = new Map()   // hexKey -> hypercore
const printed = new Map() // hexKey -> number of messages already shown
const AUTO = !!process.env.NAZBU_AUTO

function show (from, text) {
  if (AUTO) { console.log(`[${name}] recv <- ${from}: ${text}`); return }
  process.stdout.write('\r\x1b[K' + `${from}: ${text}\n`)
  rl.prompt(true)
}

async function drain (hex, core) {
  const from = printed.get(hex) || 0
  for (let i = from; i < core.length; i++) {
    try {
      const msg = JSON.parse((await core.get(i)).toString())
      show(msg.from, msg.text)
    } catch (_) {}
  }
  printed.set(hex, core.length)
}

async function trackCore (hex) {
  if (cores.has(hex)) return
  const core = store.get({ key: Buffer.from(hex, 'hex') })
  await core.ready()
  cores.set(hex, core)
  core.on('append', () => drain(hex, core))
  core.update().then(() => drain(hex, core)).catch(() => {})
}

let rl
let local

async function main () {
  local = store.get({ name: 'local' })
  await local.ready()
  const myKey = local.key.toString('hex')
  cores.set(myKey, local)
  local.on('append', () => drain(myKey, local)) // echoes our own line once

  const transport = createTransport({ myKey })
  transport.events.on('peer-key', trackCore)
  transport.events.on('connection', (stream, isInitiator) => {
    const rep = store.replicate(isInitiator)
    rep.on('error', () => {})
    stream.on('error', () => {})
    rep.pipe(stream).pipe(rep)
  })
  await transport.start()

  console.log(`\n[Nazbu chat] "${name}" online via ${transport.name} — no internet needed.`)
  console.log('[Nazbu chat] type a message and press ENTER. Ctrl+C to quit.\n')

  if (AUTO) {
    let n = 0
    setInterval(() => local.append(Buffer.from(JSON.stringify({ from: name, text: 'msg ' + (++n) }))), 1500)
    return
  }

  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `[${name}] > ` })
  rl.prompt()
  rl.on('line', async line => {
    if (line.trim()) await local.append(Buffer.from(JSON.stringify({ from: name, text: line })))
    rl.prompt()
  })
  rl.on('SIGINT', () => process.exit(0))
}

main().catch(err => { console.error('[Nazbu chat] fatal:', err); process.exit(1) })
