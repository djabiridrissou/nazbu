#!/usr/bin/env node
'use strict'

/*
 * Nazbu shared-stock demo — the Womola model in miniature.
 *
 * Two (or more) tills share the same catalog. A sale is NOT "set stock = 4",
 * it's a MOVEMENT event (qty: -1) appended to the Nazbu log. Every machine
 * computes:  stock = initial + sum(all movements).
 *
 * Because summing is commutative, machines never conflict — and if two offline
 * tills both sell the last unit, the stock goes NEGATIVE, which correctly
 * SURFACES the oversell instead of silently losing a write. That's exactly the
 * behaviour Womola needs when the Wi-Fi drops.
 *
 *   node stock.js till-1      # machine 1
 *   node stock.js till-2      # machine 2
 *
 * No server. No internet. Re-syncs automatically on reconnect.
 */

const readline = require('readline')
const Nazbu = require('./index')

// Same initial stock on every machine (a constant, part of the "catalog").
const CATALOG = {
  '1': { sku: 'PARA', name: 'Paracetamol', initial: 5 },
  '2': { sku: 'AMOX', name: 'Amoxicillin', initial: 3 }
}
const BY_SKU = {}
for (const k of Object.keys(CATALOG)) BY_SKU[CATALOG[k].sku] = CATALOG[k]

const name = process.argv[2] || 'till'
const AUTO = !!process.env.NAZBU_AUTO
const movements = {} // sku -> summed deltas
for (const k of Object.keys(BY_SKU)) movements[k] = 0

let room
const stockOf = sku => BY_SKU[sku].initial + movements[sku]

function render () {
  if (AUTO) return
  process.stdout.write('\x1b[2J\x1b[H')
  const linked = room.links
  const warn = room.peers > 0 && linked === 0 ? '  ⚠️ seen but NOT connected (firewall/AP?)' : ''
  console.log(`[Nazbu stock — ${name}]   peers: ${room.peers}   linked: ${linked}${warn}\n`)
  for (const k of Object.keys(CATALOG)) {
    const { sku, name: pname } = CATALOG[k]
    const s = stockOf(sku)
    const flag = s < 0 ? '   ⚠️  OVERSELL!' : ''
    console.log(`  [${k}] ${sku}  ${pname.padEnd(13)} stock: ${String(s).padStart(3)}${flag}`)
  }
  console.log('\n  keys:  1 / 2 = sell   r = restock PARA   q = quit')
}

function apply (mv) {
  if (mv && movements[mv.sku] != null) { movements[mv.sku] += mv.qty; render() }
}

async function main () {
  const RM = process.env.NAZBU_ROOM || 'nazbu-stock'
  room = new Nazbu({ name, room: RM, internet: process.env.NAZBU_INTERNET === '1', storage: './.nazbu-stock/' + RM + '/' + name })
  room.on('message', apply)
  room.on('peers', render)
  room.on('link', render)
  await room.start()

  if (AUTO) {
    // Both tills hammer the same product to force an oversell, then log it.
    setInterval(() => room.send({ sku: 'PARA', qty: -1 }), 900)
    setInterval(() => console.log(`[${name}] peers=${room.peers} PARA=${stockOf('PARA')} AMOX=${stockOf('AMOX')}`), 1000)
    return
  }

  render()
  readline.emitKeypressEvents(process.stdin)
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('keypress', async (ch, k) => {
    if (!k) return
    if (k.name === 'q' || (k.ctrl && k.name === 'c')) process.exit(0)
    if (k.name === '1') await room.send({ sku: 'PARA', qty: -1 })
    if (k.name === '2') await room.send({ sku: 'AMOX', qty: -1 })
    if (k.name === 'r') await room.send({ sku: 'PARA', qty: +1 })
  })
}

main().catch(err => { console.error('[Nazbu stock] fatal:', err); process.exit(1) })
