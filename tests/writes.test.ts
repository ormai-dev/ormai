import { describe, it, expect } from "vitest"
import { Valv, emit, emitInsert, emitUpdate, emitDelete, BASE_FUNCTIONS } from "@valv/core"
import type {
  ValvAdapter,
  SchemaMap,
  Query,
  CompiledQuery,
  InjectedMutation,
  MutationResult,
  FnDef,
  DefaultContext,
  Dialect,
} from "@valv/core"
import { createValv } from "@valv/clickhouse"
import type { FieldSchema } from "@valv/core"
import { fakeClient } from "./helpers"

const f = (
  name: string,
  type: FieldSchema["type"],
  extra: Partial<FieldSchema> = {},
): FieldSchema => ({
  name,
  type,
  nativeType: type === "number" ? "Int64" : "String",
  isNullable: false,
  isId: false,
  ...extra,
})

const schema: SchemaMap = {
  resources: {
    orders: {
      name: "orders",
      tableName: "orders",
      relations: {},
      fields: {
        id: f("id", "string", { isId: true, hasDefaultValue: true }),
        tenant_id: f("tenant_id", "string"),
        status: f("status", "string"),
        total: f("total", "number"),
        internal_notes: f("internal_notes", "string", { sensitive: true, isNullable: true }),
      },
    },
  },
}

const ctx: DefaultContext = { user: { id: "u1", role: "member" }, tenant: { id: "acme" } }

// A minimal Postgres-like adapter that records emitted writes, so we can assert
// the SQL the full core pipeline produces (incl. injected scope).
const pgDialect: Dialect = { quoteId: (id) => `"${id}"`, placeholder: (i) => `$${i + 1}` }

function pgValv() {
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
  valv.policy("orders", (c) => ({
    read: { tenant_id: c.tenant!.id },
    create: { tenant_id: c.tenant!.id },
    update: { tenant_id: c.tenant!.id },
    delete: { tenant_id: c.tenant!.id },
  }))
  return { valv, writes }
}

describe("writes — full pipeline", () => {
  it("forces server-owned fields onto an insert", async () => {
    const { valv, writes } = pgValv()
    await valv.create({ from: "orders", data: { status: "pending", total: 100 } }, ctx)
    expect(writes[0].sql).toBe(
      'INSERT INTO "orders" ("status", "total", "tenant_id") VALUES ($1, $2, $3)',
    )
    expect(writes[0].params.map((p) => p.value)).toEqual(["pending", 100, "acme"])
  })

  it("AND-injects the scope predicate into an update's WHERE", async () => {
    const { valv, writes } = pgValv()
    await valv.update({ from: "orders", data: { status: "shipped" }, where: { id: "o1" } }, ctx)
    expect(writes[0].sql).toBe(
      'UPDATE "orders" SET "status" = $1 WHERE (("id" = $2) AND ("tenant_id" = $3))',
    )
    expect(writes[0].params.map((p) => p.value)).toEqual(["shipped", "o1", "acme"])
  })

  it("AND-injects the scope predicate into a delete's WHERE", async () => {
    const { valv, writes } = pgValv()
    await valv.delete({ from: "orders", where: { id: "o1" } }, ctx)
    expect(writes[0].sql).toBe('DELETE FROM "orders" WHERE (("id" = $1) AND ("tenant_id" = $2))')
    expect(writes[0].params.map((p) => p.value)).toEqual(["o1", "acme"])
  })

  it("requires a where on delete", async () => {
    const { valv } = pgValv()
    await expect(valv.delete({ from: "orders" }, ctx)).rejects.toThrow()
  })

  it("can't set the scope column (no escaping your tenant)", async () => {
    const { valv } = pgValv()
    await expect(
      valv.update({ from: "orders", data: { tenant_id: "other" }, where: { id: "o1" } }, ctx),
    ).rejects.toThrow(/not writable/)
  })

  it("can't set a sensitive column", async () => {
    const { valv } = pgValv()
    await expect(
      valv.create({ from: "orders", data: { status: "x", total: 1, internal_notes: "leak" } }, ctx),
    ).rejects.toThrow(/not writable/)
  })

  it("can't filter a write by a column it can't read", async () => {
    const { valv } = pgValv()
    await expect(
      valv.update({ from: "orders", data: { status: "x" }, where: { internal_notes: "y" } }, ctx),
    ).rejects.toThrow(/not accessible/)
  })

  it("rejects an insert missing a required column", async () => {
    const { valv } = pgValv()
    await expect(valv.create({ from: "orders", data: { status: "x" } }, ctx)).rejects.toThrow(
      /required/,
    )
  })

  it("denies a write with no policy for the operation", async () => {
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
      async mutate(m: InjectedMutation, cat) {
        writes.push(emitInsert(m as never, cat, pgDialect))
        return { affected: 1 }
      },
    }
    const valv = new Valv<DefaultContext>({ adapter, defaultPolicy: "deny-all" })
    valv.policy("orders", (c) => ({ read: { tenant_id: c.tenant!.id } })) // read only — no create
    await expect(
      valv.create({ from: "orders", data: { status: "x", total: 1 } }, ctx),
    ).rejects.toThrow(/denied/)
    expect(writes).toHaveLength(0)
  })
})

describe("writes — ClickHouse (insert only)", () => {
  function chValv() {
    const client = fakeClient()
    return { client, inserts: client.inserts }
  }

  it("forces fields and inserts via the client", async () => {
    const { client, inserts } = chValv()
    const valv = await createValv<DefaultContext>(client, { schema, defaultPolicy: "deny-all" })
    valv.policy("orders", (c) => ({ create: { tenant_id: c.tenant!.id } }))
    await valv.create({ from: "orders", data: { status: "pending", total: 100 } }, ctx)
    expect(inserts[0].table).toBe("orders")
    expect(inserts[0].values).toEqual([{ status: "pending", total: 100, tenant_id: "acme" }])
  })

  it("rejects update/delete (ClickHouse is insert-only)", async () => {
    const { client } = chValv()
    const valv = await createValv<DefaultContext>(client, { schema, defaultPolicy: "deny-all" })
    valv.policy("orders", (c) => ({
      read: { tenant_id: c.tenant!.id },
      update: { tenant_id: c.tenant!.id },
    }))
    await expect(
      valv.update({ from: "orders", data: { status: "x" }, where: { id: "o1" } }, ctx),
    ).rejects.toThrow(/inserts only/)
  })
})

describe("write tools are opt-in", () => {
  it("omits write tools by default, includes them when toggled", async () => {
    const { valv } = pgValv()
    await valv.run({ from: "orders", select: { status: true } }, ctx) // prime the schema cache
    expect(valv.tools.neutral(ctx).map((t) => t.name)).not.toContain("create")
    const withWrites = valv.tools
      .neutral(ctx, { create: true, update: true, delete: true })
      .map((t) => t.name)
    expect(withWrites).toEqual(expect.arrayContaining(["create", "update", "delete"]))
  })
})
