# nazbu-postgres

**Sync a live PostgreSQL database peer-to-peer, offline, with no server — without touching your app.**

A [Nazbu](https://github.com/djabiridrissou/nazbu) adapter for Postgres. It captures every change to
the tables you choose and replicates them across every peer in a room, applying incoming changes back
into each node's database. Your application keeps reading and writing Postgres exactly as before.

## How it works

- **Capture** — a tiny `AFTER INSERT/UPDATE/DELETE` trigger on each tracked table writes the change
  into a `_nazbu_outbox` table and fires `NOTIFY`. Your tables are never altered.
- **Sync** — Nazbu streams those changes to peers on the LAN, and across the internet with `--internet`.
- **Apply** — each node writes incoming changes back into its own Postgres, inside a transaction that
  flags the trigger to skip — so an applied change never echoes back out.
- **Conflicts** — per table: *last-writer-wins* by default (newest edit wins, Lamport-ordered), or
  *append-only* for ledgers (insert-once, deduped by primary key — nothing is ever overwritten).

State lives in three helper tables (`_nazbu_outbox`, `_nazbu_meta`, `_nazbu_cursor`). Your own tables
are untouched.

## Requirements

- PostgreSQL 13+ and a **single-column primary key** on each synced table (composite keys are skipped for now).
- The [`pg`](https://www.npmjs.com/package/pg) driver.

## Use it — one line

```js
const { Pool } = require('pg')
const Nazbu = require('nazbu')

const pool = new Pool({ connectionString: 'postgres://127.0.0.1:5432/mydb' })

const room = new Nazbu({
  db: pool,                 // your existing connection
  room: 'hospital-42',      // who this node syncs with
  internet: true,           // also sync across networks
  policies: {
    sales: 'append-only',   // ledgers never merge lossily
    '*':   'last-writer-wins'
  }
})

await room.start()          // offline · multi-node · converging
```

## Or run it as a sidecar (no app change at all)

```bash
node run.js --room hospital-42 --name hub-1 \
  --uri "postgres://user:pass@127.0.0.1:5432/mydb" \
  --ledger sales,journal_entries \
  --internet
```

| Flag | Meaning |
|---|---|
| `--room` | Sync group — one room per site/tenant. |
| `--name` | This node's name (in logs). |
| `--uri` | Your Postgres connection string. |
| `--tables` | Comma-separated allowlist (default: every table in `public`). |
| `--exclude` | Tables to skip. |
| `--ledger` | Tables to treat as append-only (money/ledgers). |
| `--internet` | Also sync across networks, not just the LAN. |

## Test

Needs a running Postgres; the test creates and drops its own databases.

```bash
PG_URI=postgres://127.0.0.1:5432/postgres npm test
```

Verifies insert / update / bidirectional update (last-writer-wins) / delete propagation, and
append-only ledger union — two databases syncing over real Nazbu P2P.

## Status

v1 — proven end-to-end. Current limits: single-column primary keys, `public` schema, scalar &
JSON columns. Composite keys, multiple schemas and richer type mapping are next.

MIT · a companion to [Nazbu](https://github.com/djabiridrissou/nazbu).
