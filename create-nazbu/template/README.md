# my-nazbu-app

A local-first P2P app built with [Nazbu](https://github.com/djabiridrissou/nazbu).
No server. No internet. Machines on the same Wi-Fi sync in real time.

## Run

```bash
npm install
node app.js alice        # then on another machine: node app.js bob
```

Type a message and press ENTER — it appears on every machine in the same room.

## Where to go next

Open `app.js`. The whole API is three lines:

```js
const room = new Nazbu({ name, room: 'my-app' })
room.on('message', (data, meta) => { /* received from a peer */ })
room.send({ anything: 'you want' })            // broadcast to everyone
```

Model changing quantities (stock, cash) as `+1 / -1` movement events so offline
peers merge without conflicts. See the Nazbu README for the full guide.
