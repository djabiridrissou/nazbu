# Nazbu

**Deploy any app to a local network, in one click. No server. No internet. Real-time P2P sync.**

Install the desktop app on each machine, put them on the same access point, and
everyone is online together — instantly, with no central server and no internet
connection anywhere.

Built on the [Hypercore](https://docs.pears.com/) P2P stack.

---

## Why

Most apps die the moment the internet drops. A pharmacy, a shop, a warehouse —
all their tills go dark because a router upstream failed.

Nazbu flips it: the **local network is the backend**. Each machine carries its
own copy of the data, discovers its peers on the LAN, and keeps everyone in sync
in real time. Internet becomes optional — used only to back up to the cloud when
it happens to be available.

## Status — Phase 0 (proof of concept) ✅

This repo currently proves the single hardest part: **two nodes on the same LAN,
with no internet, that discover each other and sync shared state live.**

- Discovery: **mDNS** (link-local multicast) — needs a switch/access point, *not*
  the internet.
- Data: each node has its own append-only **Hypercore** log.
- Transport: plain TCP + **Corestore** replication.
- Shared state: the sum of every node's log length — conflict-free, so it's
  genuinely multi-writer with zero coordination.

### Try it (two terminals, no internet required)

```bash
npm install

# terminal 1
node nazbu.js alice

# terminal 2
node nazbu.js bob
```

Press **SPACE** in either terminal to +1. Watch `TOTAL` climb in **both** — even
with Wi-Fi's internet turned off. Press `q` to quit.

> Two machines? Run `node nazbu.js <name>` on each, on the same access point.

## Roadmap

- **Phase 0 — Discovery + replication on LAN, offline.** ✅ *(this repo)*
- **Phase 1 — WebSocket-like shim.** A familiar emit/listen API for the frontend,
  backed by P2P replication — so existing web apps barely change.
- **Phase 2 — CLI + template.** `npx create-nazbu` → an app running on the LAN,
  plus an install page and manual.
- **Phase 3 — Flagship demo.** Port a real React + Node.js app onto Nazbu.

## License

MIT
