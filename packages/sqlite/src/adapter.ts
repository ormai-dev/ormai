import type { ValvAdapter, SchemaMap, Query, CompiledQuery, FnDef } from "@valv/core"
import { emit, BASE_FUNCTIONS, sqliteDialect } from "@valv/core"
import { introspectSqlite, type SqliteClient } from "./introspection"

export interface SqliteAdapterOptions {
  /** Declare the schema by hand instead of reading the database's own catalog. */
  schema?: SchemaMap
}

// Read-only adapter: no `mutate`, so core refuses writes. Adding writes is
// emit{Insert,Update,Delete} over the same driver, when a real need appears.
//
// Two things the Postgres and MySQL adapters do are deliberately absent here:
//
//  - No session pinning. Those adapters force the session to UTC so date_trunc /
//    DATE_FORMAT bucket on stable boundaries. SQLite's strftime is always UTC and
//    has no session zone, so there is nothing to pin.
//
//  - No statement timeout. SQLite has no server-side per-statement cap, and
//    better-sqlite3 runs synchronously on the calling thread, so there is no
//    timer that could interrupt a running query. A runaway query is bounded by
//    core's query cost limits (row caps, join limits) rather than by the clock.
//    Callers that need a hard wall-clock bound should run valv off the main
//    thread — a worker whose whole handle can be torn down.
export class SqliteAdapter implements ValvAdapter {
  private schemaCache: SchemaMap | null = null

  constructor(
    private client: SqliteClient,
    private options: SqliteAdapterOptions = {},
  ) {}

  async introspect(): Promise<SchemaMap> {
    this.schemaCache ??= this.options.schema ?? introspectSqlite(this.client)
    return this.schemaCache
  }

  compile(query: Query, catalog: SchemaMap): CompiledQuery {
    // No `database` option: SQLite has one schema per handle (ATTACHed databases
    // aside), so emitted tables stay unqualified.
    return emit(query, catalog, sqliteDialect)
  }

  async run(query: Query, catalog: SchemaMap): Promise<unknown[]> {
    const compiled = this.compile(query, catalog)
    return this.execute(
      compiled.sql,
      compiled.params.map((param) => param.value),
    )
  }

  functions(): Record<string, FnDef> {
    return { ...BASE_FUNCTIONS, ...sqliteDialect.functions }
  }

  async execute(sql: string, parameters: unknown[] = []): Promise<unknown[]> {
    // better-sqlite3 is synchronous; the async signature is the ValvAdapter
    // contract, not a hint that this yields.
    return this.client.prepare(sql).all(...parameters)
  }
}
