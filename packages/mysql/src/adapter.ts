import type { ValvAdapter, SchemaMap, Query, CompiledQuery, FnDef } from "@valv/core"
import { emit, BASE_FUNCTIONS, mysqlDialect } from "@valv/core"
import { introspectMysql, type MySqlClient } from "./introspection"

export interface MySqlAdapterOptions {
  /** Declare the schema by hand instead of querying information_schema. */
  schema?: SchemaMap
  /** Database to introspect and qualify tables with. Defaults to the connection's current database. */
  database?: string
  /**
   * Per-query wall-clock cap in milliseconds (`max_execution_time`, which MySQL
   * enforces for read-only SELECTs). Defaults to 10000. Raise it for heavier
   * analytical workloads; keep it low to bound a runaway query.
   */
  statementTimeoutMs?: number
}

// Default per-query wall-clock cap so a structurally-valid query (e.g. a join
// that scans far more than expected) can't run away on the server. Override per
// instance with `statementTimeoutMs`.
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000

// Read-only adapter: no `mutate`, so core refuses writes. Adding writes is
// emit{Insert,Update,Delete} over the same driver, when a real need appears.
export class MySqlAdapter implements ValvAdapter {
  private schemaCache: SchemaMap | null = null

  private get timeoutMs(): number {
    return this.options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS
  }

  constructor(
    private client: MySqlClient,
    private options: MySqlAdapterOptions = {},
  ) {}

  async introspect(): Promise<SchemaMap> {
    this.schemaCache ??=
      this.options.schema ?? (await introspectMysql(this.client, this.options.database))
    return this.schemaCache
  }

  compile(query: Query, catalog: SchemaMap): CompiledQuery {
    return emit(query, catalog, mysqlDialect, { database: this.options.database })
  }

  async run(query: Query, catalog: SchemaMap): Promise<unknown[]> {
    const compiled = this.compile(query, catalog)
    return this.execute(
      compiled.sql,
      compiled.params.map((param) => param.value),
    )
  }

  functions(): Record<string, FnDef> {
    return { ...BASE_FUNCTIONS, ...mysqlDialect.functions }
  }

  async execute(sql: string, parameters: unknown[] = []): Promise<unknown[]> {
    // Pin the session before the query runs. The timeout is a numeric config
    // value and the zone is a literal — neither is model input, and a number
    // can't carry SQL, so inlining them is safe:
    //  - max_execution_time caps read-only SELECT wall-clock.
    //  - time_zone '+00:00' forces DATE_FORMAT bucketing (and any tz-sensitive
    //    read of a TIMESTAMP column, which MySQL converts from UTC storage to the
    //    session zone) to land on UTC boundaries, stable across environments.
    // These are session statements, so they need a dedicated connection — the
    // consumer passes one per request, not a shared pool (see MySqlClient).
    await this.client.query(`SET SESSION max_execution_time = ${this.timeoutMs}`)
    await this.client.query(`SET time_zone = '+00:00'`)
    const [result] = await this.client.query(sql, parameters)
    return (result ?? []) as unknown[]
  }
}
