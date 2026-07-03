#!/usr/bin/env node
'use strict'

/*
 * Nazbu chat — now built on the Nazbu library (see index.js).
 * The whole P2P/offline/re-sync machinery is gone from here — it's just an app.
 *
 *   node chat.js alice      # machine 1
 *   node chat.js bob        # machine 2
 */

const readline = require('readline')
const Nazbu = require('./index')

const name = process.argv[2] || 'me'
const AUTO = !!process.env.NAZBU_AUTO
let rl

async function main () {
  const room = new Nazbu({ name, storage: './.nazbu-chat/' + name })

  room.on('message', (text, meta) => {
    if (AUTO) { console.log(`[${name}] recv <- ${meta.from}: ${text}`); return }
    process.stdout.write('\r\x1b[K' + `${meta.from}: ${text}\n`)
    rl.prompt(true)
  })

  await room.start()
  console.log(`\n[Nazbu chat] "${name}" online — no server, no internet. Type + ENTER.\n`)

  if (AUTO) {
    let n = 0
    setInterval(() => room.send('msg ' + (++n)), 1500)
    return
  }

  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `[${name}] > ` })
  rl.prompt()
  rl.on('line', async line => {
    if (line.trim()) await room.send(line)
    rl.prompt()
  })
  rl.on('SIGINT', () => process.exit(0))
}

main().catch(err => { console.error('[Nazbu chat] fatal:', err); process.exit(1) })
