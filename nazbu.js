#!/usr/bin/env node
'use strict'

/*
 * Nazbu counter — the original demo, now built on the Nazbu library.
 * Every SPACE broadcasts a +1 to every machine on the LAN. No server, no
 * internet. The total re-syncs automatically when peers reconnect.
 *
 *   node nazbu.js alice      # machine 1
 *   node nazbu.js bob        # machine 2
 */

const readline = require('readline')
const Nazbu = require('./index')

const name = process.argv[2] || 'peer-' + process.pid
const AUTO = !!process.env.NAZBU_AUTO
let total = 0
let room

function render () {
  if (AUTO) return
  process.stdout.write('\r\x1b[K' + `[Nazbu:${name}]  peers:${room.peers}  linked:${room.links}  TOTAL:${total}   (SPACE = +1, q = quit)`)
}

async function main () {
  room = new Nazbu({ name, room: process.env.NAZBU_ROOM || 'nazbu-counter', internet: process.env.NAZBU_INTERNET === '1' })
  room.on('message', () => { total += 1; render() })
  room.on('peers', render)
  room.on('link', render)

  await room.start()
  console.log(`\n[Nazbu] "${name}" online — no internet needed.\n`)

  if (AUTO) {
    setInterval(() => room.send(1), 1500)
    setInterval(() => console.log(`[${name}] peers=${room.peers} linked=${room.links} total=${total}`), 1000)
    return
  }

  readline.emitKeypressEvents(process.stdin)
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('keypress', async (ch, k) => {
    if (k && (k.name === 'q' || (k.ctrl && k.name === 'c'))) process.exit(0)
    if (k && k.name === 'space') await room.send(1)
  })
  render()
}

main().catch(err => { console.error('[Nazbu] fatal:', err); process.exit(1) })
