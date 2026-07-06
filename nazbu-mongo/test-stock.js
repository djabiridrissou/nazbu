'use strict'

/*
 * The real Womola scenario, proven over Nazbu P2P: two tills recording stock
 * MOVEMENTS (like Womola's StockMovement ledger) converge to the same level,
 * conflict-free, even when both oversell the same product offline.
 *
 *   node test-stock.js
 */

const Nazbu = require('../index')
const NazbuMongoBridge = require('./bridge')
const { MockLedger } = require('./stores')

const ROOM = 'stock-bridge-test'
const wait = ms => new Promise(r => setTimeout(r, ms))
let failures = 0
const check = (label, cond) => { console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`); if (!cond) failures++ }

async function main () {
  const A = new MockLedger('till-1')
  const B = new MockLedger('till-2')
  const a = new NazbuMongoBridge({ store: A, nazbu: new Nazbu({ name: 'till-1', room: ROOM, storage: './.nzs/A' }) })
  const b = new NazbuMongoBridge({ store: B, nazbu: new Nazbu({ name: 'till-2', room: ROOM, storage: './.nzs/B' }) })
  await a.start(); await b.start()
  await wait(2500)

  const P = 'PARA', L = 'shop'

  // Stock received on till-1: +5. Should reach till-2.
  A.record('A-rcpt', P, L, +5)
  await wait(2000)
  check('till-2 sees the +5 receipt (level 5)', B.level(P, L) === 5)

  // Now simulate an OFFLINE oversell: both sell 3 each (6 total) though only 5 exist.
  A.record('A-s1', P, L, -1); A.record('A-s2', P, L, -1); A.record('A-s3', P, L, -1)
  B.record('B-s1', P, L, -1); B.record('B-s2', P, L, -1); B.record('B-s3', P, L, -1)
  await wait(3500)

  check('till-1 level == -1 (oversell surfaced)', A.level(P, L) === -1)
  check('till-2 level == -1 (converged, identical)', B.level(P, L) === -1)
  check('both hold all 7 movements', A.movements.size === 7 && B.movements.size === 7)

  // Re-applying an existing movement is idempotent (dedup by id).
  const before = A.level(P, L)
  A.applyRemote({ ns: 'stockmovements', id: 'B-s1', doc: { productId: P, locationId: L, qtyDelta: -1 } })
  check('duplicate movement ignored (no double-count)', A.level(P, L) === before)

  console.log(`\n${failures === 0 ? 'ALL PASSED ✅' : failures + ' FAILED ❌'}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error('fatal:', err); process.exit(1) })
