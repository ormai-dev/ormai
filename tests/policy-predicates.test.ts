import { describe, it, expect } from "vitest"
import { createValv } from "@valv/clickhouse"
import { Valv, emit, emitInsert, emitUpdate, emitDelete, BASE_FUNCTIONS } from "@valv/core"
import type {
  SchemaMap,
  DefaultContext,
  ValvAdapter,
  Query,
  CompiledQuery,
  InjectedMutation,
  MutationResult,
  Dialect,
  Expr,
} from "@valv/core"
import { fakeClient, field } from "./helpers"

// A policy `read`/`update`/`delete` rule may now be a full Expr, not just the
// scalar-equality shorthand — so a policy can use any operator and AND/OR/NOT,
// the same grammar the model emits in a WHERE.

const schema: SchemaMap = {
  resources: {
    orders: {
      name: "orders",
      tableName: "orders",
      relations: {},
      fields: {
        id: field("id", "string", "String", { isId: true }),
        tenant_id: field("tenant_id", "string", "String"),
        region: field("region", "string", "String"),
        total: field("total", "number", "Int64"),
      },
    },
  },
}

const ctx: DefaultContext = { user: { id: "u", role: "member" }, tenant: { id: "acme" } }
const col = (name: string): Expr => ({ kind: "col", name })
const val = (value: string | number): Expr => ({ kind: "value", value })
const cmp = (op: "=" | ">" | "<", name: string, value: string | number): Expr => ({
  kind: "cmp",
  op,
  left: col(name),
  right: val(value),
})

async function readWith(rule: unknown) {
  const client = fakeClient([])
  const valv = await createValv<DefaultContext>(client, { schema })
  valv.policy("orders", () => ({ read: rule as never }))
  return { valv, calls: client.calls }
}

describe("policy predicates — read (Expr passthrough)", () => {
  it("compiles an operator predicate into the WHERE", async () => {
    const { valv, calls } = await readWith(cmp(">", "total", 100))
    await valv.runTool("query", { from: "orders", select: { total: true } }, ctx)
    expect(calls[0]!.query).toMatch(/`total` >/)
    expect(Object.values(calls[0]!.query_params ?? {})).toContain(100)
  })

  it("compiles an OR predicate (the union case)", async () => {
    const rule: Expr = { kind: "or", args: [cmp("=", "region", "EU"), cmp("=", "region", "US")] }
    const { valv, calls } = await readWith(rule)
    await valv.runTool("query", { from: "orders", select: { region: true } }, ctx)
    expect(calls[0]!.query).toContain(" OR ")
    const params = Object.values(calls[0]!.query_params ?? {})
    expect(params).toEqual(expect.arrayContaining(["EU", "US"]))
  })

  it("still supports the scalar-equality shorthand", async () => {
    const { valv, calls } = await readWith({ tenant_id: "acme" })
    await valv.runTool("query", { from: "orders", select: { region: true } }, ctx)
    expect(calls[0]!.query).toMatch(/`tenant_id` =/)
    expect(Object.values(calls[0]!.query_params ?? {})).toContain("acme")
  })

  it("rejects a bare column (not a boolean predicate)", async () => {
    const { valv } = await readWith(col("total"))
    await expect(
      valv.runTool("query", { from: "orders", select: { total: true } }, ctx),
    ).rejects.toThrow(/boolean expression/)
  })

  it("rejects a structurally invalid expression", async () => {
    const { valv } = await readWith({ kind: "cmp", op: "XYZ", left: col("total"), right: val(1) })
    await expect(
      valv.runTool("query", { from: "orders", select: { total: true } }, ctx),
    ).rejects.toThrow(/not a valid expression/)
  })
})

// ---- write path ----

const pgDialect: Dialect = { quoteId: (id) => `"${id}"`, placeholder: (i) => `$${i + 1}` }

function pgValv(policy: (c: DefaultContext) => Record<string, unknown>) {
  const writes: CompiledQuery[] = []
  const adapter: ValvAdapter = {
    async introspect() {
      return schema
    },
    async run(q: Query, cat) {
      emit(q, cat, pgDialect)
      return []
    },
    functions() {
      return { ...BASE_FUNCTIONS }
    },
    async mutate(m: InjectedMutation, cat): Promise<MutationResult> {
      writes.push(
        m.op === "insert"
          ? emitInsert(m, cat, pgDialect)
          : m.op === "update"
            ? emitUpdate(m, cat, pgDialect)
            : emitDelete(m, cat, pgDialect),
      )
      return { affected: 1 }
    },
  }
  const valv = new Valv<DefaultContext>({ adapter, defaultPolicy: "deny-all" })
  valv.policy("orders", policy as never)
  return { valv, writes }
}

describe("policy predicates — write path", () => {
  it("rejects an Expr rule on create (can't force a comparison onto a row)", async () => {
    const { valv } = pgValv(() => ({ create: cmp("=", "tenant_id", "acme") }))
    await expect(
      valv.create({ from: "orders", data: { region: "EU", total: 1 } }, ctx),
    ).rejects.toThrow(/scalar \{ field: value \} form/)
  })

  it("AND-injects an Expr update scope and keeps its columns server-owned", async () => {
    const { valv, writes } = pgValv(() => ({ read: true, update: cmp("=", "tenant_id", "acme") }))
    await valv.update({ from: "orders", data: { region: "US" }, where: { id: "o1" } }, ctx)
    expect(writes[0]!.sql).toContain('"tenant_id" = $')

    // tenant_id is referenced by the scope predicate, so the model can't set it.
    await expect(
      valv.update({ from: "orders", data: { tenant_id: "evil" }, where: { id: "o1" } }, ctx),
    ).rejects.toThrow()
  })
})
