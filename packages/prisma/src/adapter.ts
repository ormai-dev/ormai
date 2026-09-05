import { readFileSync } from "node:fs"
import type { PrismaClient } from "@prisma/client"
import type {
  ValvAdapter,
  SchemaMap,
  Query,
  CompiledQuery,
  FnDef,
  InjectedMutation,
  MutationResult,
} from "@valv/core"
import { emit, emitInsert, emitUpdate, emitDelete, BASE_FUNCTIONS } from "@valv/core"
import { introspectPrisma } from "./introspection"
import { dialectForProvider } from "./dialects"

export interface PrismaAdapterOptions {
  schemaPath?: string
  /** Datasource provider. Auto-detected from the schema's datasource when omitted. */
  provider?: string
}

const DEFAULT_SCHEMA = "./prisma/schema.prisma"

// Per-query wall-clock cap so a structurally-valid query (e.g. a join that scans
// far more than expected) can't run away on the server. Hardcoded for now;
// surfaced as config only if a deployment needs more headroom. Applied on
// Postgres/Cockroach via `SET LOCAL statement_timeout` inside a transaction;
// MySQL/SQLite have no per-statement equivalent here (the static join caps still
// bound query shape).
const STATEMENT_TIMEOUT_MS = 10_000

export class PrismaAdapter implements ValvAdapter {
  private prisma: PrismaClient
  private schemaPath: string
  private providerOverride?: string
  private provider: string | null = null

  constructor(prisma: PrismaClient, options?: string | PrismaAdapterOptions) {
    this.prisma = prisma
    const opts = typeof options === "string" ? { schemaPath: options } : (options ?? {})
    this.schemaPath = opts.schemaPath ?? DEFAULT_SCHEMA
    this.providerOverride = opts.provider
  }

  async introspect(): Promise<SchemaMap> {
    return introspectPrisma(this.schemaPath)
  }

  compile(query: Query, catalog: SchemaMap): CompiledQuery {
    return emit(query, catalog, dialectForProvider(this.resolveProvider()))
  }

  async run(query: Query, catalog: SchemaMap): Promise<unknown[]> {
    const compiled = this.compile(query, catalog)
    return this.execute(
      compiled.sql,
      compiled.params.map((param) => param.value),
    )
  }

  functions(): Record<string, FnDef> {
    return { ...BASE_FUNCTIONS, ...dialectForProvider(this.resolveProvider()).functions }
  }

  // Run a validated, policy-injected write. The forced values / scope predicate
  // are already baked into the mutation, so executing it can't be widened.
  async mutate(mutation: InjectedMutation, catalog: SchemaMap): Promise<MutationResult> {
    const dialect = dialectForProvider(this.resolveProvider())
    const compiled =
      mutation.op === "insert"
        ? emitInsert(mutation, catalog, dialect)
        : mutation.op === "update"
          ? emitUpdate(mutation, catalog, dialect)
          : emitDelete(mutation, catalog, dialect)
    const affected = await this.prisma.$executeRawUnsafe(
      compiled.sql,
      ...compiled.params.map((p) => p.value),
    )
    return { affected: Number(affected) }
  }

  /**
   * Run a compiled, parameterized statement. Positional values bind to the
   * dialect's placeholders (`$1` Postgres, `?` MySQL/SQLite) via Prisma's raw
   * query interface.
   */
  async execute(sql: string, parameters: unknown[] = []): Promise<unknown[]> {
    const provider = this.resolveProvider()
    if (provider === "postgresql" || provider === "cockroachdb") {
      // SET LOCAL scopes both settings to this transaction. Values are our own
      // hardcoded literals (never user input), so inlining them is safe.
      return this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
        // Pin the session to UTC so date_trunc on a `timestamptz` buckets to UTC
        // boundaries instead of the server's local zone — otherwise dateTrunc
        // buckets shift by the server's offset and depend on where the query
        // runs. Keeps the serialized output stable across environments.
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'UTC'`)
        const rows = await tx.$queryRawUnsafe(sql, ...parameters)
        return rows as unknown[]
      })
    }
    const rows = await this.prisma.$queryRawUnsafe(sql, ...parameters)
    return rows as unknown[]
  }

  private resolveProvider(): string {
    this.provider ??= this.providerOverride ?? readProvider(this.schemaPath)
    return this.provider
  }
}

function readProvider(schemaPath: string): string {
  const content = readFileSync(schemaPath, "utf8")
  const match = content.match(/datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"([^"]+)"/)
  if (!match) {
    throw new Error(`[valv/prisma] could not determine the datasource provider from ${schemaPath}`)
  }
  return match[1]
}
