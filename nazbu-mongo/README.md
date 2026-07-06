# nazbu-mongo

A **non-invasive MongoDB sidecar** for [Nazbu](../). It mirrors a database
across machines over the local network — no server, no internet — **without
changing the app that owns the database.**

```
   App (e.g. Womola) ──writes──► MongoDB (replica set)
                                     │  change stream
                                     ▼
                          nazbu-mongo bridge ──► Nazbu P2P ──► peers' MongoDB
```

The app never imports this. It keeps writing to Mongo exactly as before; the
bridge watches the change stream and syncs. New app features that write to Mongo
are picked up automatically — nothing to wire, nothing to break.

## How it works

- **Watch:** `db.watch()` (needs a replica set — Womola already runs `--replSet rs0`).
- **Broadcast:** each change becomes a Nazbu event `{ ns, id, doc, v, by }`.
- **Apply:** peers apply it to their local Mongo with **last-write-wins** by a
  Lamport version.
- **No loops:** applied-remote writes are marked so the watcher won't rebroadcast them.

## Test it (no Mongo needed)

The bridge is storage-agnostic, so the end-to-end test runs over real Nazbu P2P
with an in-memory store:

```bash
node test.js      # insert / conflict / delete propagate, no echo loop
```

## Point it at Womola (real Mongo)

```js
const { MongoClient } = require('mongodb')
const Nazbu = require('nazbu')
const Bridge = require('nazbu-mongo')
const { MongoStore } = require('nazbu-mongo/stores')

const client = await new MongoClient(URI).connect()
const store = new MongoStore({ db: client.db('womoladb'), name: 'shop-till-1' })
const bridge = new Bridge({ store, nazbu: new Nazbu({ name: 'till-1', room: 'shop-42' }) })
await bridge.start()
```

## Notes / next

- **Quantities (stock, cash)** should move from last-write-wins to **movement /
  delta events** for conflict-free merges (two offline tills selling the last
  unit → oversell surfaces instead of a lost sale). See the main Nazbu README.
- Loop-prevention metadata can live in a tiny per-doc field or in a **separate
  collection** to keep app documents untouched — configurable.
