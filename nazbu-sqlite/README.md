# nazbu-sqlite

**Sync a local SQLite database peer-to-peer, offline, with no server — great for edge & mobile.**

A [Nazbu](https://github.com/djabiridrissou/nazbu) adapter for SQLite (via
[better-sqlite3](https://www.npmjs.com/package/better-sqlite3)). It captures every change to the tables
you choose and replicates them across every peer in a room, applying incoming changes back into each
node's database. Your application keeps reading and writing SQLite exactly as before.

## How it works

- **Capture** — three `AFTER INSERT/UPDATE/DELETE` triggers per tracked table write every row change into
  a `_nazbu_outbox` table. Your tables are never altered.
- **Sync** — the adapter polls the outbox and Nazbu streams the changes to peers on the LAN, and across
  the internet with `--internet`.
- **Apply** — incoming changes are written inside a transaction that flips a tiny control row
  (`_nazbu_ctl.apply = 1`); every trigger has `WHEN apply = 0`, so an applied change never echoes back.
- **Conflicts** — per table: *last-writer-wins* by default (Lamport-ordered), or *append-only* for
  ledgers (insert-once, deduped by primary key).

State lives in helper tables (`_nazbu_outbox`, `_nazbu_meta`, `_nazbu_cursor`, `_nazbu_ctl`). Your own
tables are untouched.

## Requirements

- The [`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3) driver.
- A **single-column primary key** on each synced table (composite keys are skipped for now).

## Use it — one line

```js
const Database = require('better-sqlite3')
const Nazbu = require('nazbu')

const db = new Database('app.db')

const room = new Nazbu({
  db,                       // your existing SQLite handle
  room: 'clinic-42',
  internet: true,
  policies: { visits: 'append-only', '*': 'last-writer-wins' }
})

await room.start()          // offline · multi-node · converging
```

## Or run it as a sidecar (no app change at all)

```bash
node run.js --room clinic-42 --name device-1 --file ./app.db --ledger visits --internet
```

`--room`, `--name`, `--file`, `--tables`, `--exclude`, `--ledger`, `--internet`.

## Test

```bash
npm test
```

Two SQLite files sync over real Nazbu P2P — verifies insert / update / bidirectional update
(last-writer-wins) / delete propagation, and append-only ledger union.

## Status

v1 — proven end-to-end. Current limits: single-column primary keys, scalar & JSON columns. Composite
keys and richer type mapping are next.

MIT · a companion to [Nazbu](https://github.com/djabiridrissou/nazbu).
