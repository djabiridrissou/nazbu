# Deploy — Womola shop server + Nazbu sidecar

Architecture: **one server PC per shop** runs Womola (backend + frontend + Mongo)
plus the Nazbu sidecar. The other tills are just a **browser** pointed at that PC.
Nazbu syncs the shop server's stock ledger to the **boss's online node** whenever
the internet is available — no central cloud server required, nothing lost offline.

```
  SHOP (bad internet)                                  BOSS (online)
  ┌─────────────────────────────┐                     ┌───────────────┐
  │  Server PC (Windows)         │                     │  Boss node     │
  │  Womola (be+fe) + Mongo      │── internet (DHT) ──▶│  Mongo + Nazbu │
  │  + Nazbu sidecar ────────────┼─ when net blinks on │  (VPS/cloud)   │
  └──────────┬──────────────────┘                     └───────────────┘
       browser │ browser
     till-1   till-2   (no install — just a browser to the server PC)
```

Womola is **never modified**. The sidecar only watches Mongo's `StockMovement`
ledger and keeps its own `_nazbu_meta` collection.

## Shop server (Windows)

1. Install **Docker Desktop** and make sure Womola is running
   (`docker compose -f docker-compose.prod.yml up -d`).
2. Clone this repo next to `womola_prod`, then:
   ```
   cd nazbu\deploy
   copy nazbu.env.example nazbu.env
   ```
   Edit `nazbu.env`: set `NAZBU_ROOM` (unique per shop, e.g. `shop-42`) and the
   `MONGO_ROOT_USER` / `MONGO_ROOT_PASSWORD` (same as Womola's).
3. Double-click **`start-shop.bat`** (or run it). It builds and starts one
   container, `womola_nazbu`, and tails its logs.

The other tills need nothing installed — open `http://<server-pc-ip>:<womola-port>`
in a browser.

## Mac / Linux

Same, but run `./start-shop.sh`.

## Boss node (online)

On a VPS (or the boss's always-online machine), run the same sidecar in the
**same room**, pointed at the boss's own Mongo — its `StockLevel` will mirror the
shop's. Reuse `docker-compose.nazbu.yml` with the boss's Mongo, or run directly:

```bash
cd nazbu-mongo && npm install
node run.js --room shop-42 --name boss --internet \
            --uri "mongodb://…boss-mongo…/?replicaSet=rs0" --db womoladb
```

## Notes / gotchas

- **Mongo host discovery:** the URI uses `directConnection=true` so the sidecar
  container reaches Mongo by the service name `mongo` without replica-set member
  resolution surprises. Change streams still work (Mongo is a replica set).
- **Compose path:** the launchers assume `womola_prod` sits next to this repo. If
  not, set `WOMOLA_COMPOSE=/path/to/docker-compose.prod.yml` before running.
- **One-click installer:** this Docker bundle is the pragmatic v1. A native
  Windows `.exe` (bundling Node + Mongo + Nazbu as services, no Docker Desktop) is
  the next step if you want a lighter, more "consumer" install.
