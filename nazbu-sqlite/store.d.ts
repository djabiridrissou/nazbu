/** Minimal structural type for a better-sqlite3 Database. */
export interface SqliteDbLike {
  prepare(sql: string): any
  exec(sql: string): unknown
  transaction(fn: (...args: any[]) => any): (...args: any[]) => any
  pragma?(sql: string): unknown
}

export type Policy = 'last-writer-wins' | 'append-only' | 'ledger'

export interface SqliteStoreOptions {
  /** A better-sqlite3 Database: new Database('app.db'). */
  db: SqliteDbLike
  /** This node's name (used for conflict tie-breaks + logs). */
  name?: string
  /** Per-table conflict policy. Use '*' for the default. */
  policies?: Record<string, Policy>
  /** Only sync these tables (default: every user table). */
  tables?: string[] | null
  /** Tables to skip. */
  exclude?: string[]
  /** Outbox poll interval in ms (default 500). */
  pollMs?: number
}

/**
 * SqliteStore — a Nazbu store adapter for SQLite. Usually you don't use it
 * directly: `new Nazbu({ db, room })` wires it for you.
 */
export declare class SqliteStore {
  constructor(options: SqliteStoreOptions)
  start(): this
  onLocalChange(cb: (change: any) => void): void
  applyRemote(change: any): boolean
  close(): void
}
