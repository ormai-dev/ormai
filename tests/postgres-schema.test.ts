import { describe, it, expect } from "vitest"
import { PostgresAdapter, type PostgresSql } from "@valv/postgres"
import type { SchemaMap } from "@valv/core"

// A client that fails if queried — proves the hand-defined path never touches
// information_schema.
const throwingClient: PostgresSql = {
  unsafe() {
    throw new Error("introspect() must not query the database when a schema is provided")
  },
  begin() {
    throw new Error("introspect() must not open a transaction")
  },
}

// Canned information_schema rows for a two-table schema with one FK
// (orders.customer_id → customers.id). The fake dispatches on the query text.
const columnRows = [
  {
    table_name: "orders",
    column_name: "id",
    data_type: "integer",
    is_nullable: "NO",
    has_default: true,
  },
  {
    table_name: "orders",
    column_name: "total",
    data_type: "numeric",
    is_nullable: "NO",
    has_default: false,
  },
  {
    table_name: "orders",
    column_name: "customer_id",
    data_type: "integer",
    is_nullable: "NO",
    has_default: false,
  },
  {
    table_name: "orders",
    column_name: "created_at",
    data_type: "timestamp with time zone",
    is_nullable: "NO",
    has_default: true,
  },
  {
    table_name: "customers",
    column_name: "id",
    data_type: "integer",
    is_nullable: "NO",
    has_default: true,
  },
  {
    table_name: "customers",
    column_name: "name",
    data_type: "text",
    is_nullable: "YES",
    has_default: false,
  },
]
const pkRows = [
  { table_name: "orders", column_name: "id" },
  { table_name: "customers", column_name: "id" },
]
const fkRows = [
  {
    table_name: "orders",
    column_name: "customer_id",
    constraint_name: "orders_customer_id_fkey",
    foreign_table_name: "customers",
    foreign_column_name: "id",
  },
]

function introspectingClient(): PostgresSql {
  return {
    async unsafe(query: string) {
      if (query.includes("information_schema.columns")) return columnRows
      if (query.includes("c.relkind = 'm'")) return []
      // Keys come from pg_catalog (contype 'p'/'f'), not table_constraints, so a
      // read-only role that doesn't own the tables can still see them.
      if (query.includes("con.contype = 'p'")) return pkRows
      if (query.includes("con.contype = 'f'")) return fkRows
      throw new Error(`unexpected query: ${query}`)
    },
    async begin() {
      throw new Error("introspection does not open a transaction")
    },
  }
}

describe("postgres hand-defined schema", () => {
  it("returns the provided schema without querying the database", async () => {
    const schema: SchemaMap = { resources: {} }
    const adapter = new PostgresAdapter(throwingClient, { schema })
    await expect(adapter.introspect()).resolves.toBe(schema)
  })
})

describe("postgres introspection", () => {
  it("maps column types and picks the id", async () => {
    const adapter = new PostgresAdapter(introspectingClient())
    const { resources } = await adapter.introspect()

    expect(Object.keys(resources).sort()).toEqual(["customers", "orders"])
    const orders = resources.orders
    expect(orders.fields.id).toMatchObject({ type: "number", isId: true, isPrimaryKeyPart: true })
    expect(orders.fields.total.type).toBe("number")
    expect(orders.fields.created_at.type).toBe("date")
    expect(orders.fields.customer_id).toMatchObject({ isId: false, isPrimaryKeyPart: false })
    expect(resources.customers.fields.name).toMatchObject({ type: "string", isNullable: true })
  })

  it("derives belongsTo and the inverse hasMany from a foreign key", async () => {
    const adapter = new PostgresAdapter(introspectingClient())
    const { resources } = await adapter.introspect()

    // orders → customer (belongsTo), FK on this table.
    expect(resources.orders.relations.customer).toEqual({
      name: "customer",
      targetResource: "customers",
      type: "belongsTo",
      foreignKey: "customer_id",
      targetKey: "id",
    })
    // customers → orders (hasMany), FK on the child table.
    expect(resources.customers.relations.orders).toEqual({
      name: "orders",
      targetResource: "orders",
      type: "hasMany",
      foreignKey: "customer_id",
      targetKey: "id",
    })
  })
})

describe("postgres introspection namespace", () => {
  it("scopes the queries to the given schema and qualifies emitted tables", async () => {
    const queries: string[] = []
    const client: PostgresSql = {
      async unsafe(query: string) {
        queries.push(query)
        if (query.includes("information_schema.columns")) return columnRows
        if (query.includes("c.relkind = 'm'")) return []
        if (query.includes("con.contype = 'p'")) return pkRows
        if (query.includes("con.contype = 'f'")) return fkRows
        throw new Error(`unexpected query: ${query}`)
      },
      async begin() {
        throw new Error("introspection does not open a transaction")
      },
    }

    const adapter = new PostgresAdapter(client, { namespace: "rnacen" })
    const catalog = await adapter.introspect()

    // Every introspection query is scoped to the requested schema.
    expect(queries.some((q) => q.includes("c.table_schema = 'rnacen'"))).toBe(true)
    expect(queries.filter((q) => q.includes("n.nspname = 'rnacen'")).length).toBe(3)
    expect(queries.some((q) => q.includes("'public'"))).toBe(false)

    // Compiled SQL qualifies the table as "rnacen"."orders".
    const compiled = adapter.compile({ from: "orders", select: [{ col: "id" }] }, catalog)
    expect(compiled.sql).toContain('"rnacen"."orders"')
  })
})

describe("postgres execute", () => {
  it("runs the query in a transaction with a statement timeout", async () => {
    const statements: { sql: string; params?: unknown[] }[] = []
    const tx: PostgresSql = {
      async unsafe(sql: string, params?: unknown[]) {
        statements.push({ sql, params })
        return []
      },
      begin() {
        throw new Error("no nested transaction expected")
      },
    }
    const client: PostgresSql = {
      unsafe() {
        throw new Error("execute must run inside begin(), not on the pooled client")
      },
      async begin(cb) {
        return cb(tx)
      },
    }

    const adapter = new PostgresAdapter(client, { schema: { resources: {} } })
    await adapter.execute('SELECT "email" FROM "users" WHERE ("id" = $1)', [1])

    expect(statements[0].sql).toMatch(/SET LOCAL statement_timeout/)
    // The session is pinned to UTC so date_trunc buckets to UTC boundaries
    // regardless of the server's timezone.
    expect(statements[1].sql).toMatch(/SET LOCAL TIME ZONE 'UTC'/)
    expect(statements[2]).toEqual({
      sql: 'SELECT "email" FROM "users" WHERE ("id" = $1)',
      params: [1],
    })
  })
})
