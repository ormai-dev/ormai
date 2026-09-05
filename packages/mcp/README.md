# @valv/mcp

**Point it at a database URL. Your agent queries it safely. No SQL, no code.**

A zero-config [MCP](https://modelcontextprotocol.io) server built on [valv](../../README.md). Give it a connection string and it introspects your live schema, serves four tools (`list_resources`, `search_resources`, `describe_resource`, `query`) **read-only by default**, and enforces your policies — no SQL ever reaches the model, and it can only read what you allow.

Works with PostgreSQL, MySQL, SQLite, CockroachDB, ClickHouse, and MongoDB.

[![npm](https://img.shields.io/npm/v/@valv/mcp)](https://www.npmjs.com/package/@valv/mcp) [![license](https://img.shields.io/npm/l/@valv/mcp)](../../LICENSE)

## Guided setup

The fastest way in — it probes your database, lets you choose access, and writes the config:

```bash
npx @valv/mcp init
```

It takes either a connection string or individual fields (host, port, user, password, database), confirms the dialect, connects and shows your tables, then offers read-only / pick-tables / a policy-file stub. It then merges the server entry into the client of your choice — Claude Code, Claude Desktop, Cursor, or Codex — at project or global scope, leaving any existing config in place. Lastly it offers to install the **valv skill**, which teaches the agent how to query valv and turn results into interactive chart-report HTML files — as a skill for Claude Code (`.claude/skills`), Codex (`.agents/skills`), or Cursor (`.cursor/skills`), at project or global scope. Finally it can copy a kickstart prompt to your clipboard — paste it into your agent to explore the schema (seeding `.valv/notes.md` for future queries) and generate a single interactive `valv-map.html` overview of the database.

## Manual setup

Add it to your `.mcp.json` (or Claude Desktop config):

```json
{
  "mcpServers": {
    "db": {
      "command": "npx",
      "args": ["-y", "@valv/mcp"],
      "env": { "DATABASE_URL": "postgresql://user:pass@localhost:5432/mydb" }
    }
  }
}
```

For **ClickHouse**, use its HTTP URL and a database name:

```json
"env": { "DATABASE_URL": "http://localhost:8123", "VALV_DATABASE": "analytics" }
```

For **MongoDB**, use a standard connection string. Set `VALV_DATABASE` when the
URL does not select a database:

```json
"env": { "DATABASE_URL": "mongodb://localhost:27017", "VALV_DATABASE": "analytics" }
```

## Configuration

All via environment variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | Connection string (required; or pass as the first CLI arg). |
| `VALV_PROVIDER` | `postgresql` \| `mysql` \| `sqlite` \| `mongodb` \| `clickhouse`. Inferred from the URL when omitted. |
| `VALV_DATABASE` | Database name for ClickHouse or MongoDB. |
| `VALV_TABLES` | Comma-separated allow-list — only these tables are exposed. |
| `VALV_EXCLUDE` | Comma-separated deny-list, applied after the allow-list. |
| `VALV_POLICY_FILE` | Path to a policy module (below) for tenant scoping / hidden fields. |
| `VALV_CONTEXT` | JSON context the policy reads (e.g. `{"tenant":{"id":"acme"}}`). |
| `VALV_HTTP_PORT` | Serve over Streamable HTTP on this port instead of stdio. |

## Policy file

Without one, access is **read-only across all tables**. To restrict what the agent can see — which tables, which columns — point `VALV_POLICY_FILE` at a module that receives the configured valv instance:

```js
// valv.policy.cjs
module.exports = (valv) => {
  valv.policy("orders", () => ({
    read:   true,                          // allow reads (or { column: value } to filter rows)
    fields: { deny: ["internal_notes"] },  // hide columns from the agent
  }))
  // Tables without a policy are denied (deny-all).
}
```

Need per-request row scoping by tenant/user? That belongs in the app-controlled path, where your code supplies real identity per request — use [`@valv/mcp-sdk`](../mcp-sdk) (or pass a fixed `VALV_CONTEXT` and read it in the policy here).

## License

MIT
