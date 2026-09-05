import type { Document } from "mongodb"
import type { FnDef, Query, SchemaMap, ValvAdapter } from "@valv/core"
import { BASE_FUNCTIONS } from "@valv/core"
import { compileMongoQuery } from "./compile"
import { introspectMongo } from "./introspection"
import type { MongoDatabase } from "./types"

export interface MongoAdapterOptions {
  schema?: SchemaMap
  sampleSize?: number
  statementTimeoutMs?: number
}

export interface MongoCompiledQuery {
  collection: string
  pipeline: Document[]
}

const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000

export class MongoAdapter implements ValvAdapter {
  private schemaCache: SchemaMap | null = null

  constructor(
    private database: MongoDatabase,
    private options: MongoAdapterOptions = {},
  ) {}

  async introspect(): Promise<SchemaMap> {
    this.schemaCache ??=
      this.options.schema ??
      (await introspectMongo(this.database, {
        sampleSize: this.options.sampleSize,
        statementTimeoutMs: this.options.statementTimeoutMs,
      }))
    return this.schemaCache
  }

  compile(query: Query, catalog: SchemaMap): MongoCompiledQuery {
    return compileMongoQuery(query, catalog)
  }

  async run(query: Query, catalog: SchemaMap): Promise<unknown[]> {
    const compiled = this.compile(query, catalog)
    return this.database
      .collection(compiled.collection)
      .aggregate(compiled.pipeline, {
        maxTimeMS: this.options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
        allowDiskUse: false,
      })
      .toArray()
  }

  functions(): Record<string, FnDef> {
    return { ...BASE_FUNCTIONS }
  }
}
