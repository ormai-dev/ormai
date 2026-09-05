import { describe, it, expect } from "vitest"
import { Valv, emit, emitInsert, emitUpdate, emitDelete, BASE_FUNCTIONS } from "@valv/core"
import type {
  ValvAdapter,
  SchemaMap,
  Query,
  CompiledQuery,
  InjectedMutation,
  MutationResult,
  DefaultContext,
  Dialect,
  FieldSchema,
} from "@valv/core"
import { fakeClient } from "./helpers"
import { createValv } from "@valv/clickhouse"

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
        status: f("status", "enum", { enumValues: ["pending", "shipped", "delivered"] }),
        priority: f("priority", "enum", {
          enumValues: ["low", "high"],
          isNullable: true,
          hasDefaultValue: true,
        }),
        total: f("total", "number"),
      },
    },
  },
}

const ctx: DefaultContext = { user: { id: "u1", role: "member" }, tenant: { id: "acme" } }

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

// Query + describe run through runTool, which needs the schema primed — that
// only happens via createValv (it introspects on construction).
async function chValv() {
  const valv = await createValv<DefaultContext>(fakeClient([]), { schema })
  valv.policy("orders", (c) => ({ read: { tenant_id: c.tenant!.id } }))
  return valv
}

describe("enum value validation", () => {
  it("rejects a filter on a bad enum value and lists the valid ones", async () => {
    const valv = await chValv()
    await expect(
      valv.runTool(
        "query",
        { from: "orders", select: { id: true }, where: { status: "shippd" } },
        ctx,
      ),
    ).rejects.toThrow(/Invalid value for "status"\. Allowed values: pending, shipped, delivered\./)
  })

  it("accepts a filter on a valid enum value", async () => {
    const valv = await chValv()
    await expect(
      valv.runTool(
        "query",
        { from: "orders", select: { id: true }, where: { status: "shipped" } },
        ctx,
      ),
    ).resolves.not.toThrow()
  })

  it("accepts an enum comparison against null (IS NULL semantics)", async () => {
    const valv = await chValv()
    await expect(
      valv.runTool(
        "query",
        { from: "orders", select: { id: true }, where: { priority: null } },
        ctx,
      ),
    ).resolves.not.toThrow()
  })

  it("rejects a bad enum value nested in AND/OR/NOT", async () => {
    const valv = await chValv()
    const where = { OR: [{ NOT: { status: "lost" } }, { total: 5 }] }
    await expect(
      valv.runTool("query", { from: "orders", select: { id: true }, where }, ctx),
    ).rejects.toThrow(/Invalid value for "status"/)
  })

  it("rejects a bad enum value on insert", async () => {
    const { valv } = pgValv()
    await expect(
      valv.create({ from: "orders", data: { status: "nope", total: 1 } }, ctx),
    ).rejects.toThrow(/Invalid value for "status"\. Allowed values: pending, shipped, delivered\./)
  })

  it("rejects a bad enum value on update set", async () => {
    const { valv } = pgValv()
    await expect(
      valv.update({ from: "orders", data: { status: "nope" }, where: { id: "o1" } }, ctx),
    ).rejects.toThrow(/Invalid value for "status"/)
  })

  it("rejects a bad enum value in an update/delete where", async () => {
    const { valv } = pgValv()
    await expect(valv.delete({ from: "orders", where: { status: "nope" } }, ctx)).rejects.toThrow(
      /Invalid value for "status"/,
    )
  })

  it("accepts a valid enum value on insert", async () => {
    const { valv, writes } = pgValv()
    await valv.create({ from: "orders", data: { status: "pending", total: 1 } }, ctx)
    expect(writes).toHaveLength(1)
  })

  it("describe_resource advertises the enum's valid values", async () => {
    const valv = await chValv()
    const detail = (await valv.runTool("describe_resource", { resource: "orders" }, ctx)) as {
      fields: { name: string; type: string; enumValues?: string[] }[]
    }
    const status = detail.fields.find((f) => f.name === "status")
    expect(status?.enumValues).toEqual(["pending", "shipped", "delivered"])
    // Non-enum fields carry no enumValues.
    expect(detail.fields.find((f) => f.name === "total")?.enumValues).toBeUndefined()
  })
})
