'use strict'

/*
 * End-to-end test of the bridge over REAL Nazbu P2P (loopback), using two
 * in-memory stores. Proves: a DB write on machine A shows up on machine B,
 * and last-write-wins resolves a conflicting edit — all with no server.
 *
 *   node test.js
 */

const Nazbu = require('../index')
const NazbuMongoBridge = require('./bridge')
const { MockStore } = require('./stores')

const ROOM = 'bridge-test'
const wait = ms => new Promise(r => setTimeout(r, ms))

let failures = 0
function check (label, cond) {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (!cond) failures++
}

async function main () {
  const storeA = new MockStore('A')
  const storeB = new MockStore('B')

  const a = new NazbuMongoBridge({ store: storeA, nazbu: new Nazbu({ name: 'A', room: ROOM, storage: './.nzt/A' }) })
  const b = new NazbuMongoBridge({ store: storeB, nazbu: new Nazbu({ name: 'B', room: ROOM, storage: './.nzt/B' }) })
  await a.start()
  await b.start()
  await wait(2500) // let them discover + link

  // 1) A writes a product → B should receive it.
  storeA.write('products', 'PARA', { name: 'Paracetamol', stock: 5 })
  await wait(2500)
  check('B received A\'s insert', JSON.stringify(storeB.get('products', 'PARA')) === JSON.stringify({ name: 'Paracetamol', stock: 5 }))

  // 2) B edits the same product later → A should converge (last-write-wins).
  storeB.write('products', 'PARA', { name: 'Paracetamol', stock: 4 })
  await wait(2500)
  check('A converged to B\'s newer edit (stock 4)', (storeA.get('products', 'PARA') || {}).stock === 4)

  // 3) A deletes it → B should delete too.
  storeA.delete('products', 'PARA')
  await wait(2500)
  check('B applied the delete', storeB.get('products', 'PARA') === null)

  // 4) No echo loop: bounded number of applied changes.
  check('no broadcast loop (A applied <= 3)', a.applied <= 3 && b.applied <= 3)

  console.log(`\n${failures === 0 ? 'ALL PASSED ✅' : failures + ' FAILED ❌'}  (A sent=${a.sent} applied=${a.applied} | B sent=${b.sent} applied=${b.applied})`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error('fatal:', err); process.exit(1) })
