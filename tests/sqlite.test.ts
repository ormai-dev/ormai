import { describe, it, expect } from "vitest"
import { SqliteAdapter, introspectSqlite, type SqliteClient } from "@valv/sqlite"
import type { SchemaMap, Query } from "@valv/core"

// A fake better-sqlite3 `Database`: routes PRAGMA/catalog queries to canned rows
// by inspecting the SQL, records every call, and returns rows synchronously like
// the real driver. The structural SqliteClient means no better-sqlite3 install
// is needed to exercise the adapter.
function fakeSqlite(handler: (sql: string) => unknown[] = () => []) {
  const calls: { sql: string; params: unknown[] }[] = []
  const client: SqliteClient & { calls: typeof calls } = {
    calls,
    prepare(sql: string) {
      return {
        all(...params: unknown[]): unknown[] {
          calls.push({ sql, params })
          return handler(sql)
        },
      }
    },
  }
  return client
}

// ── compile ──────────────────────────────────────────────────────────────────

const schema: SchemaMap = {
  resources: {
    orders: {
      name: "orders",
      tableName: "orders",
      relations: {},
      fields: {
        id: { name: "id", type: "number", nativeType: "INTEGER", isNullable: false, isId: true },
        region: {
          name: "region",
          type: "string",
          nativeType: "TEXT",
          isNullable: false,
          isId: false,
        },
        created_at: {
          name: "created_at",
          type: "date",
          nativeType: "DATETIME",
          isNullable: false,
          isId: false,
        },
      },
    },
  },
}

describe("sqlite adapter compile", () => {
  const adapter = new SqliteAdapter(fakeSqlite(), { schema })

  it("emits double-quoted identifiers and ? placeholders", () => {
    const query: Query = {
      from: "orders",
      select: [{ col: "region" }],
      where: {
        kind: "cmp",
        op: "=",
        left: { kind: "col", name: "id" },
        right: { kind: "value", value: 1 },
      },
      limit: 10,
    }
    const compiled = adapter.compile(query, schema)
    expect(compiled.sql).toBe('SELECT "region" FROM "orders" WHERE ("id" = ?) LIMIT 10')
    expect(compiled.params.map((p) => p.value)).toEqual([1])
  })

  it("renders ilike as LIKE (SQLite has no ILIKE keyword)", () => {
    const query: Query = {
      from: "orders",
      select: [{ col: "region" }],
      where: {
        kind: "cmp",
        op: "ilike",
        left: { kind: "col", name: "region" },
        right: { kind: "value", value: "e%" },
      },
    }
    const compiled = adapter.compile(query, schema)
    expect(compiled.sql).toBe('SELECT "region" FROM "orders" WHERE ("region" LIKE ?)')
    expect(compiled.params.map((p) => p.value)).toEqual(["e%"])
  })

  it("buckets by month with strftime (dateTrunc)", () => {
    const monthly: Query = {
      from: "orders",
      select: [
        {
          fn: "dateTrunc",
          args: [
            { kind: "col", name: "created_at" },
            { kind: "value", value: "month" },
          ],
          as: "bucket",
        },
        { fn: "count", args: [], as: "orders" },
      ],
      groupBy: ["bucket"],
    }
    const { sql } = adapter.compile(monthly, schema)
    // %M would be minutes in MySQL's DATE_FORMAT but is correct for strftime.
    expect(sql).toBe(
      'SELECT strftime(\'%Y-%m-01\', "created_at") AS "bucket", count(*) AS "orders" FROM "orders" GROUP BY "bucket"',
    )
  })

  it("buckets by minute with strftime's %M, not DATE_FORMAT's %i", () => {
    const byMinute: Query = {
      from: "orders",
      select: [
        {
          fn: "dateTrunc",
          args: [
            { kind: "col", name: "created_at" },
            { kind: "value", value: "minute" },
          ],
          as: "bucket",
        },
      ],
      groupBy: ["bucket"],
    }
    const { sql } = adapter.compile(byMinute, schema)
    expect(sql).toContain("strftime('%Y-%m-%d %H:%M:00'")
  })
})

describe("sqlite adapter execute", () => {
  it("binds parameters positionally through prepare().all()", async () => {
    const client = fakeSqlite(() => [{ region: "eu" }])
    const adapter = new SqliteAdapter(client, { schema })
    const result = await adapter.execute('SELECT "region" FROM "orders" WHERE "id" = ?', [1])
    expect(result).toEqual([{ region: "eu" }])
    expect(client.calls).toEqual([
      { sql: 'SELECT "region" FROM "orders" WHERE "id" = ?', params: [1] },
    ])
  })

  it("issues no session-pinning statements (SQLite has no session zone)", async () => {
    const client = fakeSqlite(() => [])
    const adapter = new SqliteAdapter(client, { schema })
    await adapter.execute('SELECT "region" FROM "orders"', [])
    expect(client.calls).toHaveLength(1)
  })
})

// ── introspection ────────────────────────────────────────────────────────────

// PRAGMA table_info rows: pk is the 1-based position in the primary key, 0 when
// the column isn't part of one.
const tableInfo: Record<string, unknown[]> = {
  orders: [
    col("id", "INTEGER", 1, null, 1),
    col("customer_id", "INTEGER", 1, null, 0),
    col("total", "REAL", 0, null, 0),
    col("created_at", "DATETIME", 0, "CURRENT_TIMESTAMP", 0),
    col("is_paid", "BOOLEAN", 1, "0", 0),
    col("payload", "JSON", 0, null, 0),
  ],
  customers: [col("id", "TEXT", 1, null, 1), col("name", "TEXT", 1, null, 0)],
  // Composite PK, and a composite FK back to orders → the FK must be dropped.
  order_lines: [col("order_id", "INTEGER", 1, null, 1), col("line_no", "INTEGER", 1, null, 2)],
}

const foreignKeys: Record<string, unknown[]> = {
  // `to` null → targets the parent's primary key implicitly.
  orders: [fk(0, 0, "customers", "customer_id", null)],
  order_lines: [fk(0, 0, "orders", "order_id", "id"), fk(0, 1, "orders", "line_no", "line_no")],
  customers: [],
}

function col(name: string, type: string, notnull: number, dflt: string | null, pk: number) {
  return { name, type, notnull, dflt_value: dflt, pk }
}

function fk(id: number, seq: number, table: string, from: string, to: string | null) {
  return { id, seq, table, from, to }
}

const introspectHandler = (sql: string): unknown[] => {
  if (sql.includes("sqlite_master")) return Object.keys(tableInfo).map((name) => ({ name }))
  const table = /pragma \w+\("(.+)"\)/.exec(sql)?.[1] ?? ""
  if (sql.includes("table_info")) return tableInfo[table] ?? []
  if (sql.includes("foreign_key_list")) return foreignKeys[table] ?? []
  return []
}

describe("sqlite introspection", () => {
  it("maps columns, types, and primary keys", () => {
    const map = introspectSqlite(fakeSqlite(introspectHandler))
    const o = map.resources.orders
    expect(o).toBeDefined()

    expect(o.fields.id.isId).toBe(true)
    expect(o.fields.id.isPrimaryKeyPart).toBe(true)
    expect(o.fields.customer_id.isPrimaryKeyPart).toBe(false)

    expect(o.fields.total.type).toBe("number")
    expect(o.fields.total.isNullable).toBe(true)

    // Declared-name types SQLite has no native equivalent for.
    expect(o.fields.created_at.type).toBe("date")
    expect(o.fields.created_at.hasDefaultValue).toBe(true)
    expect(o.fields.is_paid.type).toBe("boolean")
    expect(o.fields.payload.type).toBe("json")

    // TEXT primary key on customers, so the affinity path is exercised too.
    expect(map.resources.customers.fields.id.type).toBe("string")
  })

  it("treats INTEGER PRIMARY KEY as a rowid alias with a default", () => {
    const map = introspectSqlite(fakeSqlite(introspectHandler))
    expect(map.resources.orders.fields.id.hasDefaultValue).toBe(true)
    expect(map.resources.orders.fields.id.isNullable).toBe(false)
    // A TEXT primary key is not a rowid alias, so it gets no implicit default.
    expect(map.resources.customers.fields.id.hasDefaultValue).toBe(false)
  })

  it("resolves an implicit FK target to the parent's primary key", () => {
    const map = introspectSqlite(fakeSqlite(introspectHandler))
    // orders.customer_id → customers.id, named off the "_id" column. PRAGMA
    // reported `to` as null, so "id" comes from customers' own primary key.
    expect(map.resources.orders.relations.customer).toMatchObject({
      targetResource: "customers",
      type: "belongsTo",
      foreignKey: "customer_id",
      targetKey: "id",
    })
    // Inverse hasMany, named off the child table (already plural, so unchanged).
    expect(map.resources.customers.relations.orders).toMatchObject({
      targetResource: "orders",
      type: "hasMany",
      foreignKey: "customer_id",
      targetKey: "id",
    })
  })

  it("drops composite foreign keys rather than emitting a wrong join key", () => {
    const map = introspectSqlite(fakeSqlite(introspectHandler))
    expect(map.resources.order_lines.relations).toEqual({})
    // orders gains no hasMany back from order_lines either — its only relation
    // is the belongsTo from its own single-column FK to customers.
    expect(Object.keys(map.resources.orders.relations)).toEqual(["customer"])
  })

  it("orders composite primary key columns by their pk position", () => {
    const map = introspectSqlite(fakeSqlite(introspectHandler))
    const lines = map.resources.order_lines
    expect(lines.fields.order_id.isPrimaryKeyPart).toBe(true)
    expect(lines.fields.line_no.isPrimaryKeyPart).toBe(true)
    // No column named "id", so the first PK column becomes the id.
    expect(lines.fields.order_id.isId).toBe(true)
  })

  it("skips SQLite's internal tables", () => {
    const client = fakeSqlite(introspectHandler)
    introspectSqlite(client)
    const catalogQuery = client.calls[0].sql
    expect(catalogQuery).toContain("name not like 'sqlite_%'")
  })
})
