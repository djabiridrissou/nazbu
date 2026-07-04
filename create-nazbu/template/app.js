'use strict'

/*
 * Your Nazbu app. This is a tiny real-time message board to start from —
 * edit send()/on('message') to build whatever you want.
 *
 *   node app.js alice        # this machine
 *   node app.js bob          # another machine on the same Wi-Fi
 *
 * No server. No internet. Same room → they sync.
 */

const readline = require('readline')
const Nazbu = require('nazbu')

const name = process.argv[2] || 'me'

async function main () {
  // Everyone in the same `room` syncs together. Change it per shop/tenant.
  const room = new Nazbu({ name, room: '__ROOM__' })

  room.on('peers', n => console.log(`\n— peers online: ${n} —`))
  room.on('message', (data, meta) => {
    if (meta.from !== name) process.stdout.write('\r')
    console.log(`${meta.from}: ${data}`)
  })

  await room.start()
  console.log(`Connected as "${name}". Type a message + ENTER (Ctrl+C to quit).\n`)

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  rl.on('line', line => { if (line.trim()) room.send(line) })
}

main().catch(err => { console.error('fatal:', err); process.exit(1) })
