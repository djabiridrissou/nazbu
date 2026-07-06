#!/usr/bin/env node
'use strict'

/*
 * Nazbu network map — a live view of the machines on your LAN.
 *
 *   node map.js [room]        # default room: nazbu-stock
 *
 * Shows every node in the room and whether it's actually CONNECTED (🟢) or just
 * seen on the network (🟡). Great for debugging: if you see 🟡 everywhere, the
 * machines find each other but a firewall / AP isolation blocks the data link.
 */

const Nazbu = require('./index')

const room = process.argv[2] || process.env.NAZBU_ROOM || 'nazbu-stock'
const AUTO = !!process.env.NAZBU_AUTO

function draw (n) {
  const rows = n.map()
  const others = rows.filter(r => !r.self)
  const linked = others.filter(r => r.linked).length

  if (AUTO) {
    console.log(`map room=${room} you=${n.name} discovered=${others.length} connected=${linked} ` +
      others.map(r => `${r.name}:${r.linked ? 'link' : 'seen'}`).join(' '))
    return
  }

  process.stdout.write('\x1b[2J\x1b[H')
  console.log(`\n  Nazbu network map   ·   room "${room}"\n`)
  console.log(`  you: ${n.name}      discovered: ${others.length}      connected: ${linked}\n`)
  console.log('  STATUS    NAME               KEY')
  console.log('  ' + '─'.repeat(42))
  for (const r of rows) {
    const status = r.self ? '◆ you  ' : (r.linked ? '🟢 link' : '🟡 seen')
    console.log(`  ${status}   ${String(r.name).padEnd(16)}   ${r.key}`)
  }
  if (others.length && linked === 0) {
    console.log('\n  ⚠️  Seen but not connected — allow node through the firewall')
    console.log('     on every machine, or use a phone hotspot (no client isolation).')
  }
  console.log('\n  (live · Ctrl+C to quit)')
}

async function main () {
  const n = new Nazbu({
    name: process.env.NAZBU_NAME || 'map',
    room,
    storage: './.nazbu-map/' + room
  })
  n.on('peers', () => draw(n))
  n.on('link', () => draw(n))
  n.on('message', () => draw(n))

  await n.start()
  draw(n)
  setInterval(() => draw(n), 1500)
}

main().catch(err => { console.error('[Nazbu map] fatal:', err); process.exit(1) })
