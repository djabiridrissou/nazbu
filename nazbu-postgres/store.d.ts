/** Minimal structural type for a node-postgres Pool (so this needs no @types/pg). */
export interface PgPoolLike {
  connect(): Promise<any>
  query(text: string, params?: any[]): Promise<any>
}

export type Policy = 'last-writer-wins' | 'append-only' | 'ledger'

export interface PostgresStoreOptions {
  /** A pg Pool: new Pool({ connectionString }). */
  pool: PgPoolLike
  /** This node's name (used for conflict tie-breaks + logs). */
  name?: string
  /** Per-table conflict policy. Use '*' for the default. */
  policies?: Record<string, Policy>
  /** Only sync these tables (default: every table in the schema). */
  tables?: string[] | null
  /** Tables to skip. */
  exclude?: string[]
  /** Schema to track. Default: 'public'. */
  schema?: string
}

/**
 * PostgresStore — a Nazbu store adapter for PostgreSQL. Usually you don't use it
 * directly: `new Nazbu({ db: pool, room })` wires it for you.
 */
export declare class PostgresStore {
  constructor(options: PostgresStoreOptions)
  /** Create triggers/tables and start listening for changes. */
  start(): Promise<this>
  /** Register a callback for local database changes. */
  onLocalChange(cb: (change: any) => void): void
  /** Apply a peer's change to the local database. */
  applyRemote(change: any): Promise<boolean>
  /** Stop listening and release the connection. */
  close(): Promise<void>
}
