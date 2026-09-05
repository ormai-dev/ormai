import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs"
import { resolve, join, dirname } from "node:path"
import { homedir } from "node:os"
import { spawnSync } from "node:child_process"
import { inferProvider, type McpProvider, type ServerConfig } from "./config"
import { listDatabaseResources } from "./index"

type Clack = typeof import("@clack/prompts")

// @clack/prompts is ESM-only; load it via a real dynamic import so this
// CommonJS-compiled package doesn't downlevel the import to require().
async function loadClack(): Promise<Clack> {
  return (await (Function('return import("@clack/prompts")')() as Promise<Clack>)) as Clack
}

/** Interactive setup: probe a database, choose access, emit the MCP config. */
export async function runInit(): Promise<void> {
  const p = await loadClack()
  p.intro("valv · set up a database MCP server")

  const conn = await collectConnection(p)
  if (!conn) return void p.cancel("Cancelled.")
  const { url, provider, database } = conn

  // Probe: actually connect + introspect before wiring anything up.
  const spin = p.spinner()
  spin.start("Connecting and introspecting…")
  let resources: string[]
  try {
    resources = await listDatabaseResources({ databaseUrl: url, provider, database })
  } catch (err) {
    spin.stop("Could not connect.")
    return void p.cancel(err instanceof Error ? err.message : String(err))
  }
  spin.stop(`Connected — found ${resources.length} table(s).`)
  if (resources.length) p.note(resources.join(", "), "Tables")

  const mode = await p.select<"all" | "pick" | "policy">({
    message: "Access",
    initialValue: "all",
    options: [
      { value: "all", label: "Read-only — all tables" },
      { value: "pick", label: "Read-only — choose tables" },
      { value: "policy", label: "Custom policy file (generate a stub to edit)" },
    ],
  })
  if (p.isCancel(mode)) return void p.cancel("Cancelled.")

  const env: Record<string, string> = { DATABASE_URL: url, VALV_PROVIDER: provider }
  if (database) env.VALV_DATABASE = database

  if (mode === "pick") {
    const chosen = await p.multiselect<string>({
      message: "Tables to expose",
      options: resources.map((r) => ({ value: r, label: r })),
      required: true,
    })
    if (p.isCancel(chosen)) return void p.cancel("Cancelled.")
    env.VALV_TABLES = chosen.join(",")
  } else if (mode === "policy") {
    writeFileSync(resolve("valv.policy.cjs"), policyStub(resources))
    env.VALV_POLICY_FILE = "./valv.policy.cjs"
    p.note("Wrote valv.policy.cjs — edit it to scope access per resource.", "Policy")
  }

  const name = await p.text({
    message: "Name this server",
    initialValue: defaultName(url, database),
  })
  if (p.isCancel(name)) return void p.cancel("Cancelled.")

  p.note(snippet(name, env), "Add to your MCP client config")

  const targets = await chooseInstallTargets(p)
  if (targets.length === 0) {
    p.log.info("Copy the snippet above into your MCP client config.")
  } else {
    for (const target of targets) {
      try {
        installServer(target, name, env)
        p.log.success(`Wrote ${target.displayPath} — restart ${target.client} to load it.`)
      } catch (err) {
        p.log.warn(
          `Could not write ${target.displayPath}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  await maybeInstallSkill(p)
  await maybeCopyMapPrompt(p, name)

  p.outro("All set.")
}

const PROVIDER_OPTIONS = [
  { value: "postgresql" as const, label: "PostgreSQL" },
  { value: "mysql" as const, label: "MySQL" },
  { value: "sqlite" as const, label: "SQLite" },
  { value: "clickhouse" as const, label: "ClickHouse" },
  { value: "mongodb" as const, label: "MongoDB" },
]

interface Connection {
  url: string
  provider: McpProvider
  /** Optional database override passed through VALV_DATABASE. */
  database?: string
}

/** Collect connection details either from a pasted URL or individual fields. */
async function collectConnection(p: Clack): Promise<Connection | null> {
  const method = await p.select<"string" | "fields">({
    message: "How do you want to connect?",
    initialValue: "string",
    options: [
      { value: "string", label: "Connection string", hint: "paste a URL" },
      { value: "fields", label: "Individual fields", hint: "host, port, user, …" },
    ],
  })
  if (p.isCancel(method)) return null
  return method === "fields" ? collectFromFields(p) : collectFromString(p)
}

async function collectFromString(p: Clack): Promise<Connection | null> {
  const url = await p.text({
    message: "Database connection string",
    placeholder: "postgres://…   or   http://localhost:8123",
    initialValue: process.env.DATABASE_URL ?? "",
    validate: (v) => (v?.trim() ? undefined : "Required."),
  })
  if (p.isCancel(url)) return null

  let detected: McpProvider = "postgresql"
  try {
    detected = inferProvider(url)
  } catch {
    // unrecognized scheme — fall back to the default and let the user pick
  }

  const provider = await p.select<McpProvider>({
    message: "Database type",
    initialValue: detected,
    options: PROVIDER_OPTIONS,
  })
  if (p.isCancel(provider)) return null

  let database: string | undefined
  if (provider === "clickhouse" || provider === "mongodb") {
    const db = await p.text({
      message: `${provider === "clickhouse" ? "ClickHouse" : "MongoDB"} database name`,
      initialValue: provider === "clickhouse" ? "default" : "",
    })
    if (p.isCancel(db)) return null
    database = db.trim() || undefined
  }
  return { url, provider, database }
}

const DEFAULT_PORT: Partial<Record<McpProvider, number>> = {
  postgresql: 5432,
  mysql: 3306,
  clickhouse: 8123,
  mongodb: 27017,
}
const DEFAULT_USER: Partial<Record<McpProvider, string>> = {
  postgresql: "postgres",
  mysql: "root",
  clickhouse: "default",
}

async function collectFromFields(p: Clack): Promise<Connection | null> {
  const provider = await p.select<McpProvider>({
    message: "Database type",
    options: PROVIDER_OPTIONS,
  })
  if (p.isCancel(provider)) return null

  // SQLite has no host/port/credentials — it's just a file on disk.
  if (provider === "sqlite") {
    const file = await p.text({
      message: "Database file path",
      placeholder: "./data.db",
      validate: (v) => (v?.trim() ? undefined : "Required."),
    })
    if (p.isCancel(file)) return null
    return { url: `file:${file.trim()}`, provider }
  }

  const host = await p.text({
    message: "Host",
    initialValue: "localhost",
    validate: (v) => (v?.trim() ? undefined : "Required."),
  })
  if (p.isCancel(host)) return null

  const port = await p.text({
    message: "Port",
    initialValue: String(DEFAULT_PORT[provider] ?? ""),
    validate: (v) => (!v || /^\d+$/.test(v.trim()) ? undefined : "Must be a number."),
  })
  if (p.isCancel(port)) return null

  const user = await p.text({ message: "User", initialValue: DEFAULT_USER[provider] ?? "" })
  if (p.isCancel(user)) return null

  const password = await p.password({ message: "Password (leave blank if none)" })
  if (p.isCancel(password)) return null

  const dbLabel = provider === "clickhouse" ? "default" : ""
  const database = await p.text({
    message: provider === "clickhouse" ? "Database name" : "Database name (optional)",
    initialValue: dbLabel,
  })
  if (p.isCancel(database)) return null

  const parts = {
    host: host.trim(),
    port: port.trim(),
    user: user.trim(),
    password,
    database: database.trim(),
  }
  const url = buildConnectionString(provider, parts)
  // ClickHouse takes the database via VALV_DATABASE, not the URL.
  return {
    url,
    provider,
    database: provider === "clickhouse" ? parts.database || undefined : undefined,
  }
}

interface ConnectionParts {
  host: string
  port: string
  user: string
  password: string
  database: string
}

/** Assemble a provider-appropriate connection string from individual fields. */
function buildConnectionString(provider: McpProvider, parts: ConnectionParts): string {
  const user = parts.user ? encodeURIComponent(parts.user) : ""
  const pass = parts.password ? `:${encodeURIComponent(parts.password)}` : ""
  const auth = user ? `${user}${pass}@` : ""
  const portPart = parts.port ? `:${parts.port}` : ""

  if (provider === "clickhouse") {
    // ClickHouse speaks HTTP; the database is carried separately via VALV_DATABASE.
    return `http://${auth}${parts.host}${portPart}`
  }
  if (provider === "mongodb") {
    const dbPart = parts.database ? `/${encodeURIComponent(parts.database)}` : ""
    return `mongodb://${auth}${parts.host}${portPart}${dbPart}`
  }
  const scheme = provider === "mysql" ? "mysql" : "postgresql"
  const dbPart = parts.database ? `/${encodeURIComponent(parts.database)}` : ""
  return `${scheme}://${auth}${parts.host}${portPart}${dbPart}`
}

type SkillAgent = "claude" | "cursor" | "codex"

// Each agent reads the open SKILL.md skills format; only the root dir differs.
const SKILL_ROOT: Record<SkillAgent, string> = {
  claude: ".claude",
  codex: ".agents",
  cursor: ".cursor",
}

/**
 * Offer to install the valv skill — it teaches the agent how to query valv and
 * build interactive chart-report HTML files. Recommended, hence the default.
 * All three agents read the same SKILL.md format, just from their own skills
 * dir. Failure here is non-fatal: the MCP server still works without it.
 */
async function maybeInstallSkill(p: Clack): Promise<void> {
  const agents = await p.multiselect<SkillAgent>({
    message:
      "Install the valv skill for which agents? It teaches them to query valv and build interactive chart reports.",
    required: false,
    initialValues: ["claude"],
    options: [
      { value: "claude", label: "Claude Code", hint: ".claude/skills" },
      { value: "codex", label: "Codex", hint: ".agents/skills" },
      { value: "cursor", label: "Cursor", hint: ".cursor/skills" },
    ],
  })
  if (p.isCancel(agents) || agents.length === 0) return

  const scope = await p.select<"project" | "global">({
    message: "Scope",
    initialValue: "global",
    options: [
      { value: "project", label: "This project" },
      { value: "global", label: "Global — all projects" },
    ],
  })
  if (p.isCancel(scope)) return

  for (const agent of agents) {
    try {
      const dest = installSkill(agent, scope)
      p.log.success(`Installed the valv skill to ${tildify(dest)}.`)
    } catch (err) {
      p.log.warn(`Could not install the skill: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

// Write the SKILL.md into the agent's skills dir; returns the path written.
function installSkill(agent: SkillAgent, scope: "project" | "global"): string {
  const root = SKILL_ROOT[agent]
  const dest =
    scope === "project"
      ? resolve(root, "skills", "valv", "SKILL.md")
      : join(homedir(), root, "skills", "valv", "SKILL.md")
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, readBundledSkill())
  return dest
}

// A ready-to-paste prompt that has the agent learn the DB (seeding .valv/notes.md
// for future queries) and render a single interactive overview of it. Names the
// MCP server so the agent targets the one we just configured.
function mapPrompt(serverName: string): string {
  return `Explore my database through the "${serverName}" valv MCP server and build a visual map of it.

If the valv skill is available, load it first and follow its conventions.

1. Discover the schema: call list_resources to list every table, then
   describe_resource on each to capture columns, types, and how tables relate.
   Note the SQL dialect and its time-bucket function.
2. Cache what you learn in .valv/notes.md (structure and semantics only, never
   result rows) so future queries skip rediscovery.
3. Create one self-contained HTML file named valv-map.html that visualizes the
   database: an interactive map of the tables and their relationships, a
   per-table breakdown (row count, key columns, a few telling distributions),
   and a mix of chart types (bar, line, doughnut) where they fit. Inline the
   data as JSON, render with Chart.js, and open the file when it's ready.
`
}

/**
 * Offer to put a kickstart prompt on the clipboard. We don't run the exploration
 * ourselves — the agent does, using the MCP + skill we just set up. Always show
 * the prompt so the user can copy it by hand if the clipboard isn't reachable.
 */
async function maybeCopyMapPrompt(p: Clack, serverName: string): Promise<void> {
  const yes = await p.confirm({
    message:
      "Copy a prompt to map your database? Paste it into your agent to explore the schema and generate an interactive DB map.",
    initialValue: true,
  })
  if (p.isCancel(yes) || !yes) return

  const prompt = mapPrompt(serverName)
  const copied = copyToClipboard(prompt)
  p.note(
    prompt.trimEnd(),
    copied ? "Prompt — copied to your clipboard" : "Prompt — copy this into your agent",
  )
}

// Pipe text to the platform clipboard tool; returns false if none is available.
function copyToClipboard(text: string): boolean {
  const tools =
    process.platform === "darwin"
      ? [["pbcopy"]]
      : process.platform === "win32"
        ? [["clip"]]
        : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]
  for (const [command, ...args] of tools) {
    try {
      if (spawnSync(command, args, { input: text }).status === 0) return true
    } catch {
      // tool not installed — try the next one
    }
  }
  return false
}

// The skill ships inside the package (dist/skill/SKILL.md, copied at build time).
// Fall back to the monorepo source so it also works when run from a checkout.
function readBundledSkill(): string {
  const candidates = [
    join(__dirname, "skill", "SKILL.md"),
    join(__dirname, "..", "..", "..", "skills", "valv", "SKILL.md"),
  ]
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, "utf8")
  }
  throw new Error("bundled skill file not found")
}

function serverEntry(env: Record<string, string>) {
  return { command: "npx", args: ["-y", "@valv/mcp"], env }
}

function snippet(name: string, env: Record<string, string>): string {
  return JSON.stringify({ mcpServers: { [name]: serverEntry(env) } }, null, 2)
}

type ClientId = "claude-code" | "claude-desktop" | "cursor" | "codex"

interface InstallTarget {
  /** Human label for the outro ("restart <client>"). */
  client: string
  /** Absolute path to the config file. */
  path: string
  /** Path shown to the user, with $HOME collapsed to ~. */
  displayPath: string
  /** Config format: shared JSON `mcpServers`, or Codex's TOML. */
  format: "json" | "toml"
}

/** Ask which client (and scope) to install into, or null to just print the snippet. */
async function chooseInstallTargets(p: Clack): Promise<InstallTarget[]> {
  const clients = await p.multiselect<ClientId>({
    message: "Install the MCP server to which clients?",
    required: false,
    options: [
      { value: "claude-code", label: "Claude Code" },
      { value: "claude-desktop", label: "Claude Desktop" },
      { value: "cursor", label: "Cursor" },
      { value: "codex", label: "Codex" },
    ],
  })
  if (p.isCancel(clients) || clients.length === 0) return []

  // Scope only affects clients with a per-project config (Claude Code, Cursor);
  // the rest are always global.
  let scope: "project" | "global" = "global"
  if (clients.some((c) => c === "claude-code" || c === "cursor")) {
    const chosen = await p.select<"project" | "global">({
      message: "Scope",
      initialValue: "global",
      options: [
        { value: "project", label: "This project" },
        { value: "global", label: "Global — all projects" },
      ],
    })
    if (p.isCancel(chosen)) return []
    scope = chosen
  }
  return clients.map((c) => resolveTarget(c, scope))
}

// Collapse the home dir to ~ for display.
function tildify(path: string): string {
  const home = homedir()
  return path.startsWith(home) ? "~" + path.slice(home.length) : path
}

function resolveTarget(client: ClientId, scope: "project" | "global"): InstallTarget {
  const home = homedir()
  const make = (label: string, path: string, format: "json" | "toml"): InstallTarget => ({
    client: label,
    path,
    displayPath: tildify(path),
    format,
  })
  switch (client) {
    case "claude-code":
      return scope === "project"
        ? make("Claude Code", resolve(".mcp.json"), "json")
        : make("Claude Code", join(home, ".claude.json"), "json")
    case "cursor":
      return scope === "project"
        ? make("Cursor", resolve(".cursor", "mcp.json"), "json")
        : make("Cursor", join(home, ".cursor", "mcp.json"), "json")
    case "claude-desktop":
      return make("Claude Desktop", claudeDesktopConfigPath(home), "json")
    case "codex":
      return make("Codex", join(home, ".codex", "config.toml"), "toml")
  }
}

function claudeDesktopConfigPath(home: string): string {
  const file = "claude_desktop_config.json"
  if (process.platform === "darwin")
    return join(home, "Library", "Application Support", "Claude", file)
  if (process.platform === "win32")
    return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", file)
  return join(home, ".config", "Claude", file)
}

function installServer(target: InstallTarget, name: string, env: Record<string, string>): void {
  mkdirSync(dirname(target.path), { recursive: true })
  if (target.format === "toml") writeCodexToml(target.path, name, env)
  else writeMcpJson(target.path, name, env)
}

/**
 * Merge our server into a `mcpServers` JSON config, preserving everything else
 * in the file. A malformed file is an error rather than something we overwrite —
 * these can be the user's global config (e.g. ~/.claude.json) with real data.
 */
function writeMcpJson(path: string, name: string, env: Record<string, string>): void {
  let doc: { mcpServers?: Record<string, unknown> } = {}
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8")
    if (raw.trim()) {
      try {
        doc = JSON.parse(raw)
      } catch {
        throw new Error(`${path} is not valid JSON; refusing to overwrite it.`)
      }
    }
  }
  doc.mcpServers ??= {}
  doc.mcpServers[name] = serverEntry(env)
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n")
}

/** Merge our server into Codex's TOML config, replacing only our own section. */
function writeCodexToml(path: string, name: string, env: Record<string, string>): void {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : ""
  writeFileSync(path, upsertCodexSection(existing, name, codexTomlBlock(name, env)))
}

function codexTomlBlock(name: string, env: Record<string, string>): string {
  const entry = serverEntry(env)
  const lines = [
    `[mcp_servers.${tomlKey(name)}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`,
  ]
  const envPairs = Object.entries(env)
  if (envPairs.length) {
    const inline = envPairs.map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`).join(", ")
    lines.push(`env = { ${inline} }`)
  }
  return lines.join("\n") + "\n"
}

// Replace an existing `[mcp_servers.<name>]` section in place (matching a bare or
// quoted key), or append a new one. We emit env as an inline table, so a section
// runs from its header to the next table header — no sub-tables to skip over.
function upsertCodexSection(text: string, name: string, block: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const header = new RegExp(`^\\[mcp_servers\\."?${esc}"?\\][^\\n]*$`, "m")
  const match = header.exec(text)
  if (!match) {
    const sep = !text ? "" : text.endsWith("\n") ? "\n" : "\n\n"
    return text + sep + block
  }
  const start = match.index
  const tail = text.slice(start + match[0].length)
  const next = tail.search(/\n\[/)
  const end = next === -1 ? text.length : start + match[0].length + next + 1
  return text.slice(0, start) + block + text.slice(end)
}

// Bare TOML key when it's safe (letters, digits, _ or -), else a quoted key.
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)
}

// A TOML basic string. JSON's string escaping is a valid subset of TOML's, so
// this safely handles quotes, backslashes, and control characters in values.
function tomlString(value: string): string {
  return JSON.stringify(value)
}

function defaultName(url: string, database?: string): string {
  if (database) return database
  const match = url.match(/\/([A-Za-z0-9_-]+)(?:\?|$)/)
  return match?.[1] || "database"
}

function policyStub(resources: string[]): string {
  const example = resources[0] ?? "orders"
  return [
    "// valv policy — controls what the agent can read. Receives the configured",
    "// valv instance. Tables without a policy are denied (deny-all).",
    `// Discovered tables: ${resources.join(", ") || "(none)"}`,
    "module.exports = (valv) => {",
    `  valv.policy(${JSON.stringify(example)}, () => ({`,
    "    read: true,            // allow reads (or { column: value } to filter rows)",
    "    fields: { deny: [] },  // column names to hide from the agent",
    "  }))",
    "}",
    "",
  ].join("\n")
}
