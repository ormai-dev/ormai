import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { PostgresAdapter, type PgQueryable, type PostgresSql } from "@valv/postgres"
import { Valv } from "@valv/core"

// @valv/postgres accepts either client family. These cover the node-postgres
// shape — a bare `query(text, values) => { rows }` — including the transaction
// paths that `SET LOCAL` depends on. The postgres.js path is covered by
// postgres-live.test.ts, which hand-wraps PGlite in the PostgresSql surface.

// ── PGlite passed directly, with no hand-written PostgresSql wrapper ─────────

describe("node-postgres shape: PGlite passed directly", () => {
  let db: PGlite
  let valv: Valv<{ tenant: { id: string } }, string>

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create table orders (
        id serial primary key,
        tenant_id text not null,
        region text not null,
        total numeric not null,
        created_at timestamptz not null
      );
      insert into orders (tenant_id, region, total, created_at) values
        ('acme',  'eu', 100.5, '2026-01-15T10:30:00Z'),
        ('acme',  'eu',  50.0, '2026-02-02T11:00:00Z'),
        ('other', 'us', 999.0, '2026-02-03T12:00:00Z');
    `)
    // PGlite exposes `query` + `transaction`, so it satisfies PgQueryable as-is.
    const adapter = new PostgresAdapter(db as unknown as PgQueryable)
    valv = new Valv({ adapter, defaultPolicy: "deny-all" })
    valv.policy("orders", (ctx) => ({ read: { tenant_id: ctx.tenant.id } }))
    await valv.loadSchema()
  })

  afterAll(async () => {
    await db.close()
  })

  const ctx = { tenant: { id: "acme" } }

  it("introspects through the node-postgres query shape", async () => {
    const { resources } = await new PostgresAdapter(db as unknown as PgQueryable).introspect()
    expect(resources.orders).toBeDefined()
    expect(resources.orders.fields.id.isPrimaryKeyPart).toBe(true)
    expect(resources.orders.fields.region.type).toBe("string")
    expect(resources.orders.fields.created_at.type).toBe("date")
  })

  it("executes a policy-scoped query", async () => {
    const result = await valv.run(
      { from: "orders", select: { region: true, total: true }, orderBy: { total: "desc" } },
      ctx,
    )
    // The 'other' tenant's 999.0 row must not appear. `total` comes back as a
    // string because node-postgres (and PGlite) return `numeric` as text rather
    // than lose precision to a float — driver behaviour we pass through, not
    // something the normalisation should quietly coerce.
    expect(result).toEqual([
      { region: "eu", total: "100.5" },
      { region: "eu", total: "50.0" },
    ])
  })

  it("applies SET LOCAL TIME ZONE inside the transaction, so dateTrunc buckets in UTC", async () => {
    const result = await valv.run(
      {
        from: "orders",
        select: { bucket: { dateTrunc: ["created_at", "month"] }, n: { count: true } },
        groupBy: ["bucket"],
        orderBy: { bucket: "asc" },
      },
      ctx,
    )
    // 2026-01-15T10:30Z and 2026-02-02T11:00Z land in January and February.
    // Without the UTC pinning these would shift with the host's zone.
    const buckets = (result as { bucket: string; n: number }[]).map((r) =>
      String(r.bucket).slice(0, 7),
    )
    expect(buckets).toEqual(["2026-01", "2026-02"])
  })
})

// ── pool leasing ─────────────────────────────────────────────────────────────

// A fake pg.Pool: `idleCount` is what distinguishes it from a bare Client, and
// `connect()` hands out a releasable connection. Recording which object each
// statement ran on proves SET LOCAL and the query share one connection — the
// whole point of the pool path, since SET LOCAL on a different backend is a
// silent no-op.
function fakePool() {
  const log: { conn: number; sql: string }[] = []
  let released = 0
  let nextConn = 0
  const pool = {
    idleCount: 1,
    async query(text: string) {
      log.push({ conn: -1, sql: text })
      return { rows: [] }
    },
    async connect() {
      const id = nextConn++
      return {
        async query(text: string) {
          log.push({ conn: id, sql: text })
          return { rows: [{ ok: true }] }
        },
        release() {
          released++
        },
      }
    },
  }
  return { pool, log, released: () => released }
}

describe("node-postgres shape: pool leasing", () => {
  it("runs SET LOCAL and the query on one leased connection, then releases it", async () => {
    const { pool, log, released } = fakePool()
    const adapter = new PostgresAdapter(pool as unknown as PgQueryable, { schema: emptySchema() })
    const rows = await adapter.execute("SELECT 1", [])

    expect(rows).toEqual([{ ok: true }])
    // Everything ran on connection 0 — nothing leaked to the pool's own query().
    expect(log.every((e) => e.conn === 0)).toBe(true)
    expect(log.map((e) => e.sql)).toEqual([
      "BEGIN",
      "SET LOCAL statement_timeout = 10000",
      "SET LOCAL TIME ZONE 'UTC'",
      "SELECT 1",
      "COMMIT",
    ])
    expect(released()).toBe(1)
  })

  it("rolls back and releases the connection when the query throws", async () => {
    const log: string[] = []
    let released = 0
    const pool = {
      idleCount: 1,
      query: async () => ({ rows: [] }),
      connect: async () => ({
        async query(text: string) {
          log.push(text)
          if (text === "SELECT boom") throw new Error("boom")
          return { rows: [] }
        },
        release() {
          released++
        },
      }),
    }
    const adapter = new PostgresAdapter(pool as unknown as PgQueryable, { schema: emptySchema() })

    await expect(adapter.execute("SELECT boom", [])).rejects.toThrow("boom")
    expect(log).toContain("ROLLBACK")
    expect(log).not.toContain("COMMIT")
    expect(released).toBe(1)
  })
})

describe("driver detection", () => {
  it("rejects a client that is neither postgres.js nor node-postgres", async () => {
    // Resolution is lazy, so the rejection surfaces on first use rather than at
    // construction — an adapter that only compiles never needs a real client.
    const adapter = new PostgresAdapter({} as unknown as PgQueryable, { schema: emptySchema() })
    await expect(adapter.execute("SELECT 1", [])).rejects.toThrow(/Unrecognised Postgres client/)
  })

  it("still accepts a postgres.js client", async () => {
    const calls: string[] = []
    const sql: PostgresSql = {
      async unsafe(query: string) {
        calls.push(query)
        return [{ ok: true }]
      },
      async begin<T>(cb: (s: PostgresSql) => Promise<T>): Promise<T> {
        calls.push("BEGIN")
        return cb(sql)
      },
    }
    const adapter = new PostgresAdapter(sql, { schema: emptySchema() })
    await adapter.execute("SELECT 1", [])
    expect(calls).toEqual([
      "BEGIN",
      "SET LOCAL statement_timeout = 10000",
      "SET LOCAL TIME ZONE 'UTC'",
      "SELECT 1",
    ])
  })
})

function emptySchema() {
  return { resources: {} }
}
