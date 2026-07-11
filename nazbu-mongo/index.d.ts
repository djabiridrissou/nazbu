export type Policy = 'last-writer-wins' | 'append-only' | 'ledger'

export interface StoreChange {
  ns: string
  id: string
  doc: any | null
  v?: number
  by?: string
  pol?: Policy
}

/** A Nazbu store adapter: emits local changes, applies remote ones. */
export interface Store {
  start?(): Promise<unknown>
  onLocalChange(cb: (change: StoreChange) => void): void
  applyRemote(change: StoreChange): boolean | Promise<boolean>
  close(): Promise<void>
}

export interface MongoStoreOptions {
  db: any
  name?: string
  tenantId?: string | null
  ledgerCollections?: string[]
  collection?: string
}

/** Syncs a tenant's entire database slice. */
export declare class MongoTenantStore implements Store {
  constructor(options: MongoStoreOptions)
  start?(): Promise<unknown>
  onLocalChange(cb: (change: StoreChange) => void): void
  applyRemote(change: StoreChange): Promise<boolean>
  close(): Promise<void>
}

/** Syncs a single append-only ledger collection (e.g. stock movements). */
export declare class MongoLedgerStore implements Store {
  constructor(options: MongoStoreOptions)
  onLocalChange(cb: (change: StoreChange) => void): void
  applyRemote(change: StoreChange): Promise<boolean>
  close(): Promise<void>
}

/** Generic last-writer-wins collection sync over change streams. */
export declare class MongoStore implements Store {
  constructor(options: MongoStoreOptions)
  onLocalChange(cb: (change: StoreChange) => void): void
  applyRemote(change: StoreChange): Promise<boolean>
  close(): Promise<void>
}

/** Wires a Store to a Nazbu node. */
export declare class Bridge {
  constructor(opts: { store: Store; nazbu: any })
  start(): Promise<this>
  readonly sent: number
  readonly applied: number
}
