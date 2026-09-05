import { Valv } from "@valv/core"
import type { DefaultContext, SchemaMap, ValvConfig } from "@valv/core"
import { MongoClient } from "mongodb"
import { MongoAdapter } from "./adapter"
import type { MongoDatabase } from "./types"

export type MongoCreateConfig<TContext> = Omit<ValvConfig<TContext, string>, "adapter"> & {
  schema: "introspect" | SchemaMap
  sampleSize?: number
  statementTimeoutMs?: number
}

export async function createValv<TContext = DefaultContext>(
  database: MongoDatabase,
  config: MongoCreateConfig<TContext>,
): Promise<Valv<TContext, string>> {
  const { schema, sampleSize, statementTimeoutMs, ...rest } = config
  const valv = new Valv<TContext, string>({
    ...rest,
    adapter: new MongoAdapter(database, {
      schema: schema === "introspect" ? undefined : schema,
      sampleSize,
      statementTimeoutMs,
    }),
  })
  await valv.loadSchema()
  return valv
}

export interface MongoValvFromUrl<TContext> {
  valv: Valv<TContext, string>
  stop(): Promise<void>
}

export async function createValvFromUrl<TContext = DefaultContext>(
  url: string,
  config: Omit<MongoCreateConfig<TContext>, "schema"> & { database?: string },
): Promise<MongoValvFromUrl<TContext>> {
  const { database, ...rest } = config
  const client = new MongoClient(url)
  await client.connect()
  try {
    const valv = await createValv<TContext>(client.db(database), {
      ...rest,
      schema: "introspect",
      strictPolicyKeys: rest.strictPolicyKeys ?? true,
    })
    return { valv, stop: () => client.close() }
  } catch (error) {
    await client.close()
    throw error
  }
}
