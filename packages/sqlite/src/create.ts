import { Valv } from "@valv/core"
import type { DefaultContext, ValvConfig, SchemaMap } from "@valv/core"
import { SqliteAdapter } from "./adapter"
import type { SqliteClient } from "./introspection"

type CreateConfig<TContext> = Omit<ValvConfig<TContext, string>, "adapter"> & {
  /** `"introspect"` the live database, or supply a hand-defined schema. */
  schema: "introspect" | SchemaMap
}

/**
 * Build a policy-gated valv instance over a better-sqlite3 `Database` (or any
 * handle with the same `prepare(sql).all(...)` shape, such as node:sqlite's
 * `DatabaseSync`). Loads the schema on construction — introspecting the
 * database's own catalog, or using the supplied one — so the returned instance
 * is ready to use. The caller owns the handle's lifecycle.
 */
export async function createValv<TContext = DefaultContext>(
  client: SqliteClient,
  config: CreateConfig<TContext>,
): Promise<Valv<TContext, string>> {
  const { schema, ...rest } = config
  const valv = new Valv<TContext, string>({
    ...rest,
    adapter: new SqliteAdapter(client, {
      schema: schema === "introspect" ? undefined : schema,
    }),
  })
  await valv.loadSchema()
  return valv
}
