import { EventEmitter } from 'events'

export = Nazbu

/**
 * Nazbu — a local-first sync engine.
 *
 * Message mode:
 *   const room = new Nazbu({ name: 'till-1', room: 'shop-42' })
 *   room.on('message', (data, meta) => { ... })
 *   await room.start()
 *   room.send({ hello: 'world' })
 *
 * Database mode — pass a pg Pool or a mongodb Db:
 *   const room = new Nazbu({ db: pool, room: 'shop-42', policies: { '*': 'last-writer-wins' } })
 *   await room.start()   // that database is now offline-first, on every node
 */
declare class Nazbu extends EventEmitter {
  constructor(options?: Nazbu.NazbuOptions)

  /** This device's friendly name. */
  readonly name: string
  /** The room (isolation boundary) this node syncs in. */
  readonly room: string
  /** Peers discovered (not necessarily connected). */
  readonly peers: number
  /** Live replication connections — real connectivity. */
  readonly links: number
  /** This node's stable public key (hex). Null until start(). */
  readonly key: string | null
  /** Database mode: local changes broadcast to peers. */
  sent: number
  /** Database mode: peer changes applied to the local database. */
  applied: number

  /** Begin discovery + replication (and DB capture in database mode). */
  start(): Promise<this>
  /** Append a message and broadcast it to every peer in the room. */
  send(data: unknown): Promise<void>
  /** Stop transports and close the local store. */
  close(): Promise<void>
  /** A live view of the network: who's here and who's connected. */
  map(): Nazbu.PeerInfo[]

  on(event: 'message', listener: (data: any, meta: Nazbu.MessageMeta) => void): this
  on(event: 'peers', listener: (count: number) => void): this
  on(event: 'link', listener: (count: number) => void): this
  on(event: string | symbol, listener: (...args: any[]) => void): this
  once(event: 'message', listener: (data: any, meta: Nazbu.MessageMeta) => void): this
  once(event: 'peers', listener: (count: number) => void): this
  once(event: 'link', listener: (count: number) => void): this
  once(event: string | symbol, listener: (...args: any[]) => void): this
}

declare namespace Nazbu {
  /** How a table/collection merges: newest wins, or append-only (never overwritten). */
  export type Policy = 'last-writer-wins' | 'append-only' | 'ledger'

  export interface NazbuOptions {
    /** Friendly device name (defaults to a per-process id). */
    name?: string
    /** Isolation boundary — only same-room nodes sync. Default: 'default'. */
    room?: string
    /** Also sync across networks (internet), not just the LAN. */
    internet?: boolean
    /** Where this node stores its local data. */
    storage?: string
    /** Database mode: a pg Pool or a mongodb Db. Nazbu wires the adapter. */
    db?: unknown
    /** Per-table/collection conflict policy. Use '*' for the default. */
    policies?: Record<string, Policy>
    /** Restrict database sync to these tables/collections. */
    tables?: string[]
    /** Tables/collections to skip. */
    exclude?: string[]
    /** Multi-tenant fence — scope sync to a single tenant. */
    tenantId?: string | null
    /** Collections/tables to treat as append-only ledgers. */
    ledger?: string[]
    /** Advanced: override the transport list entirely. */
    transports?: unknown[]
    /** Advanced: a single transport factory. */
    transport?: unknown
  }

  export interface MessageMeta {
    /** Name of the node that sent the message. */
    from: string
    /** Sender's public key (hex). */
    key: string
    /** Sequence number in the sender's log. */
    seq: number
  }

  export interface PeerInfo {
    key: string
    name: string
    self: boolean
    linked: boolean
  }

  export { Nazbu }
}
