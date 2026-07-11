/** Minimal structural type for a mysql2/promise Pool (so this needs no extra @types). */
export interface MySqlPoolLike {
  getConnection(): Promise<any>
  query(sql: string, params?: any[]): Promise<any>
}

export type Policy = 'last-writer-wins' | 'append-only' | 'ledger'

export interface MySqlStoreOptions {
  /** A mysql2/promise pool: mysql.createPool(uri). */
  pool: MySqlPoolLike
  /** This node's name (used for conflict tie-breaks + logs). */
  name?: string
  /** Per-table conflict policy. Use '*' for the default. */
  policies?: Record<string, Policy>
  /** Only sync these tables (default: every base table in the database). */
  tables?: string[] | null
  /** Tables to skip. */
  exclude?: string[]
  /** Outbox poll interval in ms (default 1000). */
  pollMs?: number
}

/**
 * MySqlStore — a Nazbu store adapter for MySQL / MariaDB. Usually you don't use
 * it directly: `new Nazbu({ db: pool, room })` wires it for you.
 */
export declare class MySqlStore {
  constructor(options: MySqlStoreOptions)
  start(): Promise<this>
  onLocalChange(cb: (change: any) => void): void
  applyRemote(change: any): Promise<boolean>
  close(): Promise<void>
}
