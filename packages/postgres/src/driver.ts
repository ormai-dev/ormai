// This package accepts either of the two Postgres client families in common use,
// and normalises them to one internal `Driver`. Neither driver is imported — the
// consumer passes their own client (and owns its connection lifecycle and
// credentials); these are structural slices of what the adapter actually calls.

/** The structural slice of a postgres.js `Sql` client. */
export interface PostgresSql {
  unsafe(query: string, parameters?: unknown[]): PromiseLike<unknown[]>
  begin<T>(callback: (sql: PostgresSql) => Promise<T>): Promise<T>
}

/**
 * The structural slice of a node-postgres client — `pg.Pool`, `pg.Client`, or
 * anything with the same `query` shape, including PGlite.
 */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export type PostgresClient = PostgresSql | PgQueryable

/**
 * What the adapter and introspection run against.
 *
 * `queryScoped` exists because the session settings the adapter relies on
 * (`statement_timeout`, `TIME ZONE 'UTC'`) are set with `SET LOCAL`, which only
 * takes effect inside a transaction and is discarded at commit. Running them
 * through a plain `query()` on a pool would be worse than useless: `SET LOCAL`
 * outside a transaction is a no-op that Postgres reports only as a warning, so
 * the timeout and the UTC pinning would silently do nothing.
 */
export interface Driver {
  /** Run a query with no session scoping — used for introspection. */
  query(sql: string, params?: unknown[]): Promise<unknown[]>
  /** Run `setup` then `sql` inside one transaction, on one connection. */
  queryScoped(setup: string[], sql: string, params: unknown[]): Promise<unknown[]>
}

// A pool hands out connections, so consecutive query() calls can land on
// different backends — `SET LOCAL` must go through an explicitly acquired
// client. `idleCount` is pg.Pool's own bookkeeping and is absent on pg.Client,
// which is what separates the two (both expose `connect`).
interface PgPool extends PgQueryable {
  connect(): Promise<PgQueryable & { release(): void }>
  idleCount: number
}

// PGlite runs in-process against a single embedded connection and exposes its
// own transaction helper rather than accepting BEGIN as a plain statement.
interface PGliteish extends PgQueryable {
  transaction<T>(callback: (tx: PgQueryable) => Promise<T>): Promise<T>
}

// `begin` and `unsafe` are postgres.js's own vocabulary — no node-postgres client
// has either (pg.Pool exposes connect/query/end, PGlite exposes query/transaction),
// so either one alone identifies the family without risk of a false positive.
function isPostgresSql(c: PostgresClient): c is PostgresSql {
  return (
    typeof (c as PostgresSql).begin === "function" ||
    typeof (c as PostgresSql).unsafe === "function"
  )
}

function isPool(c: PgQueryable): c is PgPool {
  return typeof (c as PgPool).connect === "function" && typeof (c as PgPool).idleCount === "number"
}

function isPGlite(c: PgQueryable): c is PGliteish {
  return typeof (c as PGliteish).transaction === "function"
}

export function toDriver(client: PostgresClient): Driver {
  if (isPostgresSql(client)) return postgresJsDriver(client)
  if (typeof (client as PgQueryable).query === "function")
    return nodePostgresDriver(client as PgQueryable)
  throw new TypeError(
    "[valv] Unrecognised Postgres client. Pass a postgres.js `sql` instance, a node-postgres Pool or Client, or a PGlite instance.",
  )
}

function postgresJsDriver(sql: PostgresSql): Driver {
  return {
    async query(text, params) {
      return (await sql.unsafe(text, params)) as unknown[]
    },
    queryScoped(setup, text, params) {
      return sql.begin(async (tx) => {
        for (const stmt of setup) await tx.unsafe(stmt)
        return (await tx.unsafe(text, params)) as unknown[]
      })
    },
  }
}

function nodePostgresDriver(client: PgQueryable): Driver {
  const query = async (text: string, params?: unknown[]): Promise<unknown[]> =>
    (await client.query(text, params)).rows

  // Run setup + query in a transaction on a single connection. Which connection
  // that is depends on the client: a pool must lease one, PGlite has a helper,
  // and a bare Client is already exactly one, so sequential statements are safe.
  const queryScoped: Driver["queryScoped"] = async (setup, text, params) => {
    if (isPool(client)) {
      const conn = await client.connect()
      try {
        return await runInTx(conn, setup, text, params)
      } finally {
        conn.release()
      }
    }
    if (isPGlite(client)) {
      return client.transaction(async (tx) => {
        for (const stmt of setup) await tx.query(stmt)
        return (await tx.query(text, params)).rows
      })
    }
    return runInTx(client, setup, text, params)
  }

  return { query, queryScoped }
}

async function runInTx(
  conn: PgQueryable,
  setup: string[],
  text: string,
  params: unknown[],
): Promise<unknown[]> {
  await conn.query("BEGIN")
  try {
    for (const stmt of setup) await conn.query(stmt)
    const result = await conn.query(text, params)
    await conn.query("COMMIT")
    return result.rows
  } catch (err) {
    // The original error is what the caller needs; a rollback that also fails
    // (e.g. the connection dropped) must not mask it.
    await conn.query("ROLLBACK").catch(() => {})
    throw err
  }
}
