'use strict'

/*
 * Verifies the internet (Hyperswarm/DHT) transport in isolation — no LAN.
 * Two nodes join the same room's DHT topic, find each other over the internet,
 * and sync a message. Needs internet access. DHT discovery can take ~5-20s.
 *
 *   node scripts/test-internet.js
 */

const Nazbu = require('../index')
const internetSwarm = require('../transports/internet-swarm')

const ROOM = 'nazbu-internet-selftest-4f9a2c'
const wait = ms => new Promise(r => setTimeout(r, ms))

async function main () {
  const a = new Nazbu({ name: 'A', room: ROOM, storage: './.nzi/A', transports: [internetSwarm] })
  const b = new Nazbu({ name: 'B', room: ROOM, storage: './.nzi/B', transports: [internetSwarm] })

  let got = false
  b.on('message', (d, m) => { if (m.from === 'A' && d === 'hello-over-internet') got = true })

  await a.start()
  await b.start()
  console.log('joined DHT, waiting for peer discovery over the internet…')

  for (let i = 0; i < 12 && a.links === 0; i++) await wait(2000)
  console.log(`linked after discovery — A:${a.links} B:${b.links}`)

  await a.send('hello-over-internet')
  for (let i = 0; i < 8 && !got; i++) await wait(1500)

  console.log(`\nresult: linked=${a.links > 0} message-received=${got}`)
  console.log(a.links > 0 && got ? 'INTERNET TRANSPORT OK ✅' : 'FAILED ❌')
  process.exit(a.links > 0 && got ? 0 : 1)
}

main().catch(err => { console.error('fatal:', err); process.exit(1) })
