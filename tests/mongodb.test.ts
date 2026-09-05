import { describe, expect, it } from "vitest"
import { ObjectId } from "mongodb"
import { createValv, introspectMongo, type MongoDatabase } from "@valv/mongodb"
import type { DefaultContext, FieldSchema, SchemaMap } from "@valv/core"

const field = (
  name: string,
  type: FieldSchema["type"],
  nativeType: string,
  extra: Partial<FieldSchema> = {},
): FieldSchema => ({
  name,
  type,
  nativeType,
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
        _id: field("_id", "string", "objectId", {
          isId: true,
          isPrimaryKeyPart: true,
          hasDefaultValue: true,
        }),
        tenantId: field("tenantId", "string", "string"),
        status: field("status", "string", "string"),
        total: field("total", "number", "double"),
        createdAt: field("createdAt", "date", "date"),
        internalNotes: field("internalNotes", "string", "string", { sensitive: true }),
      },
    },
  },
}

interface Call {
  collection: string
  pipeline: Record<string, unknown>[]
  options?: Record<string, unknown>
}

function fakeDatabase(rows: unknown[] = []) {
  const calls: Call[] = []
  const database: MongoDatabase = {
    listCollections() {
      return {
        async toArray() {
          return []
        },
      }
    },
    collection(collection) {
      return {
        aggregate(pipeline, options) {
          calls.push({ collection, pipeline, options })
          return {
            async toArray() {
              return rows as never[]
            },
          }
        },
      }
    },
  }
  return { database, calls }
}

const ctx: DefaultContext = {
  user: { id: "u1", role: "member" },
  tenant: { id: "acme" },
}

async function setup(rows: unknown[] = []) {
  const { database, calls } = fakeDatabase(rows)
  const valv = await createValv<DefaultContext>(database, {
    schema,
    defaultPolicy: "deny-all",
  })
  valv.policy("orders", (context) => ({
    read: { tenantId: context.tenant!.id },
    fields: { allow: ["_id", "status", "total", "createdAt"] },
  }))
  return { valv, calls }
}

describe("MongoDB query pipeline", () => {
  it("injects policy scope before projection and applies limits", async () => {
    const { valv, calls } = await setup([{ status: "paid", total: 42 }])
    const rows = await valv.run(
      {
        from: "orders",
        select: { status: true, total: true },
        where: { total: { gt: 10 } },
        orderBy: { total: "desc" },
        take: 25,
      },
      ctx,
    )

    expect(rows).toEqual([{ status: "paid", total: 42 }])
    expect(calls).toHaveLength(1)
    expect(calls[0].collection).toBe("orders")
    expect(calls[0].pipeline.map((stage) => Object.keys(stage)[0])).toEqual([
      "$match",
      "$sort",
      "$limit",
      "$project",
    ])
    expect(JSON.stringify(calls[0].pipeline[0])).toContain("acme")
    expect(calls[0].pipeline[1]).toEqual({ $sort: { total: -1 } })
    expect(calls[0].options).toMatchObject({ maxTimeMS: 10_000, allowDiskUse: false })
  })

  it("does not expose a denied field or execute the database call", async () => {
    const { valv, calls } = await setup()
    await expect(
      valv.run({ from: "orders", select: { internalNotes: true } }, ctx),
    ).rejects.toThrow(/not accessible/)
    expect(calls).toHaveLength(0)
  })

  it("compiles base aggregates and group keys", async () => {
    const { valv, calls } = await setup()
    await valv.run(
      {
        from: "orders",
        select: { status: true, revenue: { sum: "total" }, orders: { count: true } },
        groupBy: ["status"],
        orderBy: { revenue: "desc" },
      },
      ctx,
    )

    expect(calls[0].pipeline.map((stage) => Object.keys(stage)[0])).toEqual([
      "$match",
      "$group",
      "$sort",
      "$limit",
      "$project",
    ])
    expect(calls[0].pipeline[1]).toEqual({
      $group: {
        _id: { k0: "$status" },
        revenue: { $sum: "$total" },
        orders: { $sum: 1 },
      },
    })
  })

  it("coerces string ids to ObjectId and serializes ObjectId results", async () => {
    const id = new ObjectId()
    const { valv, calls } = await setup([{ _id: id }])
    const rows = await valv.run(
      { from: "orders", select: { _id: true }, where: { _id: id.toHexString() } },
      ctx,
    )

    expect(rows).toEqual([{ _id: id.toHexString() }])
    expect(calls[0].pipeline[0]).toEqual(expect.objectContaining({ $match: expect.any(Object) }))
    const expression = calls[0].pipeline[0] as { $match: unknown }
    expect(findObjectId(expression.$match)?.toHexString()).toBe(id.toHexString())
  })

  it("fails closed when a policy references an unknown field", async () => {
    const { database, calls } = fakeDatabase()
    const valv = await createValv<DefaultContext>(database, {
      schema,
      defaultPolicy: "deny-all",
    })
    valv.policy("orders", () => ({ read: { tenentId: "acme" } }))

    await expect(valv.run({ from: "orders", select: { status: true } }, ctx)).rejects.toThrow(
      /Policy references unknown field/,
    )
    expect(calls).toHaveLength(0)
  })
})

describe("MongoDB introspection", () => {
  it("merges JSON schema and sampled BSON fields", async () => {
    const id = new ObjectId()
    const database: MongoDatabase = {
      listCollections() {
        return {
          async toArray() {
            return [
              {
                name: "orders",
                type: "collection",
                options: {
                  validator: {
                    $jsonSchema: {
                      required: ["tenantId"],
                      properties: {
                        tenantId: { bsonType: "string" },
                        total: { bsonType: ["double", "null"] },
                      },
                    },
                  },
                },
              },
              { name: "system.profile", type: "collection" },
            ]
          },
        }
      },
      collection() {
        return {
          aggregate() {
            return {
              async toArray() {
                return [{ _id: id, tenantId: "acme", total: 12.5, metadata: { source: "api" } }]
              },
            }
          },
        }
      },
    }

    const catalog = await introspectMongo(database)
    expect(Object.keys(catalog.resources)).toEqual(["orders"])
    expect(catalog.resources.orders.fields._id).toMatchObject({
      type: "string",
      nativeType: "objectId",
      isId: true,
      isNullable: false,
    })
    expect(catalog.resources.orders.fields.tenantId.isNullable).toBe(false)
    expect(catalog.resources.orders.fields.total.type).toBe("number")
    expect(catalog.resources.orders.fields.metadata.type).toBe("json")
  })
})

function findObjectId(value: unknown): ObjectId | undefined {
  if (value instanceof ObjectId) return value
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findObjectId(entry)
      if (found) return found
    }
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      const found = findObjectId(entry)
      if (found) return found
    }
  }
  return undefined
}
