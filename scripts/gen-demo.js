'use strict'

/*
 * Generates the frames for the README demo GIF — two "tills" syncing shared
 * stock over Nazbu, including a Wi-Fi drop and automatic re-sync.
 *
 *   node scripts/gen-demo.js <outDir>
 *
 * Writes frame_00.svg .. frame_NN.svg. A shell step renders them to PNG and
 * assembles assets/demo.gif with ffmpeg.
 */

const fs = require('fs')
const path = require('path')

const outDir = process.argv[2] || '.'
fs.mkdirSync(outDir, { recursive: true })

const C = {
  bg: '#0d1117', card: '#161b22', stroke: '#30363d',
  green: '#3ddc97', blue: '#2f81f7', red: '#f85149',
  gray: '#8b949e', text: '#c9d1d9', white: '#ffffff', amber: '#e3b341'
}

function term (x, name, color, lines, badge) {
  const bcol = badge === 'offline' ? C.red : C.green
  let out = `
  <g transform="translate(${x},96)">
    <rect width="360" height="210" rx="12" fill="${C.card}" stroke="${C.stroke}"/>
    <circle cx="22" cy="24" r="4" fill="${C.red}"/><circle cx="36" cy="24" r="4" fill="${C.amber}"/><circle cx="50" cy="24" r="4" fill="${C.green}"/>
    <text x="76" y="29" fill="${color}" font-size="14" font-weight="600">${name}</text>
    <circle cx="316" cy="24" r="4" fill="${bcol}"/>
    <text x="326" y="29" fill="${bcol}" font-size="11" text-anchor="start">${badge === 'offline' ? 'off' : 'on'}</text>`
  lines.forEach((l, i) => {
    const col = l.color || C.text
    out += `\n    <text x="24" y="${64 + i * 26}" fill="${col}" font-size="14" font-family="ui-monospace,Menlo,monospace">${l.t}</text>`
  })
  return out + '\n  </g>'
}

function link (state) {
  if (state === 'offline') {
    return `<line x1="402" y1="200" x2="498" y2="200" stroke="${C.red}" stroke-width="3" stroke-dasharray="2 8"/>
    <text x="450" y="188" fill="${C.red}" font-size="12" text-anchor="middle" font-weight="600">Wi-Fi ✕</text>`
  }
  if (state === 'searching') {
    return `<line x1="402" y1="200" x2="498" y2="200" stroke="${C.gray}" stroke-width="3" stroke-dasharray="4 6"/>
    <text x="450" y="188" fill="${C.gray}" font-size="12" text-anchor="middle">…</text>`
  }
  return `<line x1="402" y1="200" x2="498" y2="200" stroke="${C.green}" stroke-width="3" stroke-dasharray="6 5"/>
    <text x="450" y="188" fill="${C.green}" font-size="12" text-anchor="middle" font-weight="600">sync</text>`
}

function frame (f) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 380" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif">
  <rect x="1" y="1" width="898" height="378" rx="16" fill="${C.bg}" stroke="${C.stroke}"/>
  <text x="40" y="52" fill="${C.white}" font-size="24" font-weight="700">Nazbu</text>
  <text x="132" y="52" fill="${C.gray}" font-size="15">shared stock · no server · no internet</text>
  ${term(40, 'till-1', C.green, f.left, f.lbadge)}
  ${term(500, 'till-2', C.blue, f.right, f.rbadge)}
  ${link(f.link)}
  <text x="450" y="352" fill="${f.capColor || C.text}" font-size="15" text-anchor="middle" font-weight="600">${f.cap}</text>
</svg>`
}

const P = t => ({ t }) // plain line
const G = t => ({ t, color: C.green })
const A = t => ({ t, color: C.amber })
const R = t => ({ t, color: C.red })

const frames = [
  { cap: '1 · Same Wi-Fi — the tills find each other', link: 'searching', lbadge: 'on', rbadge: 'on',
    left: [P('peers: 1'), { t: 'searching…', color: C.gray }, P(''), P('PARA  stock: 5')],
    right: [P('peers: 1'), { t: 'searching…', color: C.gray }, P(''), P('PARA  stock: 5')] },

  { cap: '2 · Connected — no server involved', link: 'sync', lbadge: 'on', rbadge: 'on',
    left: [G('peers: 2  ✓'), P(''), P(''), P('PARA  stock: 5')],
    right: [G('peers: 2  ✓'), P(''), P(''), P('PARA  stock: 5')] },

  { cap: '3 · Sell on till-1 → till-2 updates live', link: 'sync', lbadge: 'on', rbadge: 'on',
    left: [P('peers: 2'), A('> sell PARA  −1'), P(''), G('PARA  stock: 4')],
    right: [P('peers: 2'), { t: 'received −1', color: C.gray }, P(''), G('PARA  stock: 4')] },

  { cap: '4 · Sell on till-2 → till-1 updates live', link: 'sync', lbadge: 'on', rbadge: 'on',
    left: [P('peers: 2'), { t: 'received −1', color: C.gray }, P(''), G('PARA  stock: 3')],
    right: [P('peers: 2'), A('> sell PARA  −1'), P(''), G('PARA  stock: 3')] },

  { cap: '5 · Wi-Fi drops — both keep working offline', link: 'offline', lbadge: 'offline', rbadge: 'offline',
    left: [R('offline'), A('> sell PARA  −1'), P(''), P('PARA  stock: 2')],
    right: [R('offline'), A('> sell PARA  −1'), P(''), P('PARA  stock: 2')] },

  { cap: '6 · Reconnect — Nazbu re-discovers automatically', link: 'searching', lbadge: 'on', rbadge: 'on',
    left: [{ t: 'reconnecting…', color: C.amber }, P(''), P(''), P('PARA  stock: 2')],
    right: [{ t: 'reconnecting…', color: C.amber }, P(''), P(''), P('PARA  stock: 2')] },

  { cap: '7 · Merged — both movements applied, zero conflict', link: 'sync', capColor: C.green, lbadge: 'on', rbadge: 'on',
    left: [G('peers: 2  ✓ re-synced'), P(''), P(''), G('PARA  stock: 1')],
    right: [G('peers: 2  ✓ re-synced'), P(''), P(''), G('PARA  stock: 1')] }
]

frames.forEach((f, i) => {
  const name = 'frame_' + String(i).padStart(2, '0') + '.svg'
  fs.writeFileSync(path.join(outDir, name), frame(f))
})
console.log('wrote ' + frames.length + ' frames to ' + outDir)
