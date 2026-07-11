# nazbu-mysql

**Sync a live MySQL / MariaDB database peer-to-peer, offline, with no server — without touching your app.**

A [Nazbu](https://github.com/djabiridrissou/nazbu) adapter for MySQL. It captures every change to the
tables you choose and replicates them across every peer in a room, applying incoming changes back into
each node's database. Your application keeps reading and writing MySQL exactly as before.

## How it works

- **Capture** — three `AFTER INSERT/UPDATE/DELETE` triggers on each tracked table write every row change
  into a `_nazbu_outbox` table. Your tables are never altered.
- **Sync** — the adapter polls the outbox and Nazbu streams the changes to peers on the LAN, and across
  the internet with `--internet`.
- **Apply** — each node writes incoming changes back into its own MySQL on a connection where the session
  flag `@nazbu_apply = 1`; the triggers check that flag and skip, so an applied change never echoes back.
- **Conflicts** — per table: *last-writer-wins* by default (Lamport-ordered), or *append-only* for
  ledgers (insert-once, deduped by primary key — nothing is ever overwritten).

State lives in three helper tables (`_nazbu_outbox`, `_nazbu_meta`, `_nazbu_cursor`). Your own tables are
untouched.

## Requirements

- MySQL 5.7+ / 8.0+ / 9.x, or MariaDB 10.2+ (needs `JSON_OBJECT`).
- A **single-column primary key** on each synced table (composite keys are skipped for now).
- The [`mysql2`](https://www.npmjs.com/package/mysql2) driver.

## Use it — one line

```js
const mysql = require('mysql2/promise')
const Nazbu = require('nazbu')

const pool = mysql.createPool('mysql://user:pass@127.0.0.1:3306/mydb')

const room = new Nazbu({
  db: pool,                 // your existing connection
  room: 'hospital-42',
  internet: true,
  policies: { sales: 'append-only', '*': 'last-writer-wins' }
})

await room.start()          // offline · multi-node · converging
```

## Or run it as a sidecar (no app change at all)

```bash
node run.js --room hospital-42 --name hub-1 \
  --uri "mysql://user:pass@127.0.0.1:3306/mydb" \
  --ledger sales,journal_entries \
  --internet
```

`--room`, `--name`, `--uri`, `--tables`, `--exclude`, `--ledger`, `--internet` — same flags as the other
adapters.

## Test

Needs a running MySQL; the test creates and drops its own databases.

```bash
MYSQL_URI=mysql://root@127.0.0.1:3306 npm test
```

Verifies insert / update / bidirectional update (last-writer-wins) / delete propagation, and append-only
ledger union — two databases syncing over real Nazbu P2P.

## Status

v1 — proven end-to-end. Current limits: single-column primary keys, scalar & JSON columns. Composite
keys and richer type mapping are next.

MIT · a companion to [Nazbu](https://github.com/djabiridrissou/nazbu).
