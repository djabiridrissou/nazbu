#!/usr/bin/env node
'use strict'

/*
 * create-nazbu — scaffolds a new Nazbu app.
 *
 *   npm create nazbu@latest my-app      (after publish)
 *   node index.js my-app                (from this repo, works today)
 *
 * Copies the template, personalizes it, and prints the next steps.
 */

const fs = require('fs')
const path = require('path')

const target = process.argv[2] || 'my-nazbu-app'
const dest = path.resolve(process.cwd(), target)
const tpl = path.join(__dirname, 'template')

if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
  console.error(`\n✖  Directory "${target}" already exists and is not empty.\n`)
  process.exit(1)
}

function copyDir (src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    // npm strips a real .gitignore from published packages, so we ship it as
    // _gitignore and rename on scaffold.
    const name = entry.name === '_gitignore' ? '.gitignore' : entry.name
    const to = path.join(dst, name)
    if (entry.isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

copyDir(tpl, dest)

// Personalize package.json name + the app's default room.
const slug = path.basename(target).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'my-nazbu-app'
const pkgPath = path.join(dest, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.name = slug
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

const appPath = path.join(dest, 'app.js')
fs.writeFileSync(appPath, fs.readFileSync(appPath, 'utf8').replace(/__ROOM__/g, slug))

console.log(`
✔  Created ${target}

  cd ${target}
  npm install
  node app.js alice        # then on another machine: node app.js bob

Put both machines on the same Wi-Fi (internet can be off) and they sync.
No server. No internet. That's Nazbu.
`)
