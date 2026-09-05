import type { PrismaClient } from "@prisma/client"
import type { Valv } from "@valv/core"
import { createValv, prepareDatabase } from "@valv/prisma"
import { startStdioServer, startHttpServer } from "@valv/mcp-sdk"
import { applyAccess } from "./policy"
import { inferProvider, type ServerConfig } from "./config"

// Policy context is arbitrary JSON (VALV_CONTEXT). The default read-only policy
// ignores it; a policy file may read whatever shape the user passes.
type Ctx = Record<string, unknown>
type DbValv = Valv<Ctx, string>

export type { ServerConfig, Provider, McpProvider } from "./config"
export { configFromEnv, inferProvider } from "./config"

export interface RunningServer {
  /** Disconnect the database and remove the generated temp client. */
  stop: () => Promise<void>
}

// Build a valv instance + a cleanup fn for the configured database. ClickHouse
// and MongoDB use their native adapters; SQL databases introspect via Prisma.
async function buildValv(
  config: ServerConfig,
): Promise<{ valv: DbValv; stop: () => Promise<void> }> {
  const provider = config.provider ?? inferProvider(config.databaseUrl)

  if (provider === "clickhouse") {
    const { createValvFromUrl } = await import("@valv/clickhouse")
    const { valv, stop } = await createValvFromUrl<Ctx>(toClickHouseUrl(config.databaseUrl), {
      database: config.database,
      defaultPolicy: "deny-all",
    })
    return { valv, stop }
  }

  if (provider === "mongodb") {
    const { createValvFromUrl } = await import("@valv/mongodb")
    return createValvFromUrl<Ctx>(config.databaseUrl, {
      database: config.database,
      defaultPolicy: "deny-all",
    })
  }

  const prepared = await prepareDatabase(config.databaseUrl, provider)
  const valv = (await createValv<PrismaClient, Ctx>(prepared.prisma, {
    schemaPath: prepared.schemaPath,
    defaultPolicy: "deny-all",
  })) as DbValv
  const stop = async () => {
    try {
      await prepared.prisma.$disconnect()
    } finally {
      prepared.cleanup()
    }
  }
  return { valv, stop }
}

// ClickHouse's HTTP client takes an http(s):// URL; normalize a clickhouse://
// (or clickhouse+https://) scheme to it.
function toClickHouseUrl(url: string): string {
  return url
    .replace(/^clickhouse\+https:\/\//i, "https://")
    .replace(/^clickhouse(\+http)?:\/\//i, "http://")
}

/** Connect, introspect, and return the resource (table) names — used by `init`. */
export async function listDatabaseResources(config: ServerConfig): Promise<string[]> {
  const { valv, stop } = await buildValv(config)
  try {
    return await valv.resources()
  } finally {
    await stop()
  }
}

/**
 * Boot a zero-config valv MCP server against a live database: introspect the
 * schema, build a policy-gated valv instance (read-only by default), and serve
 * it over stdio (or Streamable HTTP when `httpPort` is set).
 *
 * All progress is logged to stderr so stdout stays a clean MCP channel.
 */
export async function startValvMcpServer(config: ServerConfig): Promise<RunningServer> {
  const { valv, stop } = await buildValv(config)

  const { resources } = await applyAccess(valv, config)
  process.stderr.write(
    `[valv] Exposing ${resources.length} resource(s)` +
      (config.policyFile ? " (policy file in control)" : " (read-only)") +
      `: ${resources.join(", ") || "(none)"}\n`,
  )

  // Resource scoping is enforced by policy (applyAccess denies non-allowed
  // tables); discovery is policy-filtered, so denied tables never appear.
  const options = {
    context: (): Ctx => (config.context as Ctx) ?? {},
  }

  if (config.httpPort !== undefined) {
    await startHttpServer(valv, { ...options, port: config.httpPort })
    process.stderr.write(`[valv] MCP server listening on http://localhost:${config.httpPort}/mcp\n`)
  } else {
    await startStdioServer(valv, options)
    process.stderr.write("[valv] MCP server ready on stdio.\n")
  }

  return { stop }
}
