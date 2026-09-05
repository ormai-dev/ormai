import { describe, it, expect } from "vitest"
import { createValv } from "@valv/clickhouse"
import type { SchemaMap, DefaultContext, FieldSchema, QueryInput } from "@valv/core"
import { fakeClient, field } from "./helpers"

const f = (name: string, nt: string, extra: Partial<FieldSchema> = {}): FieldSchema =>
  field(name, "string", nt, extra)

const schema: SchemaMap = {
  resources: {
    events: {
      name: "events",
      tableName: "events",
      relations: {},
      fields: {
        tenant_id: f("tenant_id", "String"),
        plan: f("plan", "String"),
        latency: f("latency", "UInt32", { type: "number" }),
      },
    },
  },
}

const ctx: DefaultContext = { user: { id: "u", role: "m" }, tenant: { id: "acme" } }

async function setup(rows: unknown[] = [{ plan: "pro" }]) {
  const client = fakeClient(rows)
  const valv = await createValv<DefaultContext>(client, { schema, defaultPolicy: "allow-all" })
  return { valv, calls: client.calls }
}

describe("querySchema() / mutationSchema()", () => {
  it("returns the exact query-tool schema, functions baked in", async () => {
    const { valv } = await setup()
    const schema = valv.querySchema() as any
    // Same shape the `query` tool advertises.
    const toolSchema = valv.tools.neutral(ctx).find((t) => t.name === "query")!.parameters
    expect(schema).toEqual(toolSchema)
    // Function catalog is resolved into the select description.
    expect(schema.properties.select.description).toContain("quantileTiming(")
    expect(schema.required).toEqual(["from", "select"])
  })

  it("returns write schemas per op", async () => {
    const { valv } = await setup()
    expect((valv.mutationSchema("create") as any).required).toEqual(["from", "data"])
    expect((valv.mutationSchema("update") as any).required).toEqual(["from", "where", "data"])
    expect((valv.mutationSchema("delete") as any).required).toEqual(["from", "where"])
  })
})

describe("functions getter", () => {
  it("exposes the connection's function catalog", async () => {
    const { valv } = await setup()
    expect(Object.keys(valv.functions)).toEqual(
      expect.arrayContaining(["count", "sum", "quantileTiming"]),
    )
  })
})

describe("strict policy keys", () => {
  it("does not retain a rejected policy registration", async () => {
    const client = fakeClient([])
    const valv = await createValv<DefaultContext>(client, {
      schema,
      defaultPolicy: "allow-all",
      strictPolicyKeys: true,
    })

    expect(() => valv.policy("event" as "events", () => ({ read: false }))).toThrow(
      /unknown resource "event"/,
    )
    await expect(valv.run({ from: "events", select: { plan: true } }, ctx)).resolves.toEqual([])
  })
})

describe("parseQuery() / parse writes", () => {
  it("parses the grammar into the internal query", async () => {
    const { valv } = await setup()
    const parsed = valv.parseQuery({
      from: "events",
      select: { plan: true, p95: { quantileTiming: [0.95, "latency"] } },
      where: { latency: { gte: 100 } },
    })
    expect(parsed.from).toBe("events")
    expect(parsed.select).toHaveLength(2)
    expect(parsed.where).toEqual({
      kind: "cmp",
      op: ">=",
      left: { kind: "col", name: "latency" },
      right: { kind: "value", value: 100 },
    })
  })

  it("validates a hand-built query before running it (throws on bad grammar)", async () => {
    const { valv } = await setup()
    expect(() => valv.parseQuery({ from: "events", select: [{ col: "plan" }] })).toThrow(
      /`select` is an object/,
    )
  })

  it("enforces the input-size guard", async () => {
    const { valv } = await setup()
    let node: unknown = { plan: "x" }
    for (let i = 0; i < 3000; i++) node = { NOT: node }
    expect(() => valv.parseQuery({ from: "events", select: { plan: true }, where: node })).toThrow(
      /too deeply nested|too large/,
    )
  })

  it("parses write payloads", async () => {
    const { valv } = await setup()
    expect(valv.parseInsert({ from: "events", data: { plan: "pro" } })).toEqual({
      from: "events",
      values: { plan: "pro" },
    })
    expect(valv.parseDelete({ from: "events", where: { plan: "pro" } }).where).toBeDefined()
    expect(() => valv.parseUpdate({ from: "events", data: { plan: "x" } })).toThrow(
      /requires a `where`/,
    )
  })
})

describe("queryTool()", () => {
  it("wraps the real query tool with a post-run transform and a custom name", async () => {
    const { valv, calls } = await setup([{ plan: "pro", n: 3 }])
    const tool = valv.queryTool(ctx, {
      name: "render_chart",
      description: "Draw a chart from a query.",
      wrap: (rows) => ({ chart: rows }),
    })

    expect(tool.name).toBe("render_chart")
    expect(tool.description).toBe("Draw a chart from a query.")
    // Schema is the real query schema, not a hand-rolled stub.
    expect(tool.parameters).toEqual(valv.querySchema())

    const out = await tool.execute({ from: "events", select: { plan: true } })
    expect(out).toEqual({ chart: [{ plan: "pro", n: 3 }] })
    // It ran the actual pipeline.
    expect(calls[0].query).toContain("SELECT `plan` FROM `events`")
  })

  it("defaults to the query tool's own name and description, and no wrap", async () => {
    const { valv } = await setup()
    const tool = valv.queryTool(ctx)
    const base = valv.tools.neutral(ctx).find((t) => t.name === "query")!
    expect(tool.name).toBe("query")
    expect(tool.description).toBe(base.description)
    const rows = await tool.execute({ from: "events", select: { plan: true } })
    expect(rows).toEqual([{ plan: "pro" }])
  })
})

// Compile-time: QueryInput types a hand-built query.
const _typed: QueryInput = {
  from: "events",
  select: { plan: true, revenue: { sum: "latency" } },
  where: { plan: "pro", latency: { gte: 10 }, OR: [{ plan: "free" }] },
  orderBy: { revenue: "desc" },
  take: 10,
}
void _typed
