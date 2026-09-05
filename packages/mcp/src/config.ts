import { inferProvider as inferPrismaProvider, type Provider } from "@valv/prisma"

// Everything Prisma introspects, plus ClickHouse (served via @valv/clickhouse).
export type McpProvider = Provider | "clickhouse"

export type { Provider }
export { inferProvider }

// ClickHouse speaks over HTTP; SQL databases use their own URL schemes. So an
// http(s):// or clickhouse:// URL is ClickHouse, and everything else falls to
// Prisma's provider inference.
function inferProvider(url: string): McpProvider {
  if (/^(clickhouse(\+https?)?|https?):\/\//i.test(url)) return "clickhouse"
  return inferPrismaProvider(url)
}

export interface ServerConfig {
  /** Database connection string. */
  databaseUrl: string
  /** Datasource provider. Inferred from the URL when omitted. */
  provider?: McpProvider
  /** Database/schema name. Used by ClickHouse and MongoDB (from VALV_DATABASE). */
  database?: string
  /** Path to a policy module that takes full control of access (optional). */
  policyFile?: string
  /** Allow-list of resource (table) names. When set, only these are exposed. */
  tables?: string[]
  /** Deny-list of resource (table) names, applied after the allow-list. */
  exclude?: string[]
  /** Policy context object (JSON). Defaults to `{}`. */
  context?: unknown
  /** When set, serve over Streamable HTTP on this port instead of stdio. */
  httpPort?: number
}

function csv(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return items.length > 0 ? items : undefined
}

/**
 * Build a {@link ServerConfig} from environment variables and CLI args.
 * The connection string comes from `DATABASE_URL` or the first positional arg.
 */
export function configFromEnv(env: NodeJS.ProcessEnv, argv: string[]): ServerConfig {
  const positional = argv.find((a) => !a.startsWith("-"))
  const databaseUrl = env.DATABASE_URL ?? positional
  if (!databaseUrl) {
    throw new Error(
      "No database connection string. Set DATABASE_URL (or pass it as the first argument).",
    )
  }

  const provider = env.VALV_PROVIDER
    ? (env.VALV_PROVIDER as McpProvider)
    : inferProvider(databaseUrl)

  let context: unknown = {}
  if (env.VALV_CONTEXT) {
    try {
      context = JSON.parse(env.VALV_CONTEXT)
    } catch {
      throw new Error("VALV_CONTEXT must be valid JSON.")
    }
  }

  const httpPort = env.VALV_HTTP_PORT ? Number(env.VALV_HTTP_PORT) : undefined
  if (httpPort !== undefined && Number.isNaN(httpPort)) {
    throw new Error("VALV_HTTP_PORT must be a number.")
  }

  return {
    databaseUrl,
    provider,
    database: env.VALV_DATABASE,
    policyFile: env.VALV_POLICY_FILE,
    tables: csv(env.VALV_TABLES),
    exclude: csv(env.VALV_EXCLUDE),
    context,
    httpPort,
  }
}
