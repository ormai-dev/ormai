import { Valv } from "@valv/core"
import type { DefaultContext, ValvConfig, SchemaMap } from "@valv/core"
import { PostgresAdapter } from "./adapter"
import type { PostgresClient } from "./driver"

type CreateConfig<TContext> = Omit<ValvConfig<TContext, string>, "adapter"> & {
  /** `"introspect"` the live database, or supply a hand-defined schema. */
  schema: "introspect" | SchemaMap
  /** Postgres schema to introspect and qualify tables with. Defaults to `public`. */
  namespace?: string
  /** Per-query wall-clock cap in milliseconds (`statement_timeout`). Defaults to 10000. */
  statementTimeoutMs?: number
}

/**
 * Build a policy-gated valv instance over a Postgres client — a postgres.js
 * `sql` instance, a node-postgres `Pool` or `Client`, or PGlite. Loads the schema
 * on construction (introspecting, or using the supplied one), so the returned
 * instance is ready to use. The caller owns the client's connection lifecycle.
 */
export async function createValv<TContext = DefaultContext>(
  client: PostgresClient,
  config: CreateConfig<TContext>,
): Promise<Valv<TContext, string>> {
  const { schema, namespace, statementTimeoutMs, ...rest } = config
  const valv = new Valv<TContext, string>({
    ...rest,
    adapter: new PostgresAdapter(client, {
      schema: schema === "introspect" ? undefined : schema,
      namespace,
      statementTimeoutMs,
    }),
  })
  await valv.loadSchema()
  return valv
}
