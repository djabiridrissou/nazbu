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

Run it on each machine, next to Womola — same `--room` per shop:

```bash
node run.js --room shop-42 --name till-1 \
            --uri "mongodb://127.0.0.1:27017/?replicaSet=rs0" --db womoladb

# add --internet so it also syncs up to the boss's online node when the net blinks on
node run.js --room shop-42 --name till-1 --internet --uri "mongodb://…" --db womoladb
```

It watches the local `StockMovement` ledger and syncs it peer-to-peer over the
LAN. Womola keeps running untouched; new stock movements just appear on every
till. Or wire it yourself:

```js
const { MongoClient } = require('mongodb')
const Nazbu = require('nazbu')
const Bridge = require('nazbu-mongo')
const { MongoLedgerStore } = require('nazbu-mongo/stores')

const client = await new MongoClient(URI).connect()
const store = new MongoLedgerStore({ db: client.db('womoladb'), name: 'till-1' })
const bridge = new Bridge({ store, nazbu: new Nazbu({ name: 'till-1', room: 'shop-42' }) })
await bridge.start()
```

## Womola stock (the ideal case)

Womola already stores stock as an **append-only ledger** — `StockMovement`
documents with a signed `qtyDelta`, plus a derived `StockLevel.totalQty`. That's
the conflict-free model, already in place. So the stock bridge:

- watches **inserts** on `stockmovements`,
- replicates each movement (dedup by `_id` → union, no last-write-wins),
- projects it into `StockLevel` with a commutative `$inc`.

Two offline tills selling the same last unit both apply both movements → the
level goes negative (oversell surfaces) instead of a sale being silently lost.
Dedup metadata lives in a **separate `_nazbu_meta` collection** — Womola's own
documents are never modified.

```bash
node test-stock.js     # proves the scenario over real Nazbu P2P (in-memory store)
node test-mongo.js     # SAME scenario against a real MongoDB replica set
```

Both pass. `test-mongo.js` runs two databases as two tills on a replica set and
verifies movements sync + `StockLevel` converges to the same value (oversell → -1)
through actual change streams — the exact `MongoLedgerStore` you'd point at Womola.

## Full offline (whole tenant) — plug & play onboarding

To run **all of Womola** offline for a tenant, `MongoTenantStore` replicates that
tenant's ENTIRE database slice: every collection, mutable ones by last-write-wins,
append-only ones by union, `stocklevels` re-derived from `stockmovements`, deletes
propagated, BSON types preserved. All scoped to one tenant.

Onboarding a tenant is one command — never per-tenant code:

```bash
# on the boss: export the tenant's slice + generate the shop config
node provision-offline.js --tenant <tenantId> --uri "<boss-mongo-uri>" --db womoladb
```

It produces `offline-bundles/<tenant>/` with the `seed/` and a ready `nazbu.env`,
and prints the exact shop + boss steps. In the shop you `seed.js import` the data,
then run the sidecar with `--full`. Same room + tenant → the shop runs 100% offline
and reconciles with the boss when the internet is around.

```bash
node run.js --full --room tenant-<id> --tenant <id> --internet --uri "<shop-mongo-uri>"
```

Proven end-to-end against real Mongo: `node test-tenant-full.js`.

## Notes / next

- **Quantities (stock, cash)** should move from last-write-wins to **movement /
  delta events** for conflict-free merges (two offline tills selling the last
  unit → oversell surfaces instead of a lost sale). See the main Nazbu README.
- Loop-prevention metadata can live in a tiny per-doc field or in a **separate
  collection** to keep app documents untouched — configurable.
