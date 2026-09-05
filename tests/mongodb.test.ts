import { describe, expect, it } from "vitest"
import { ObjectId } from "mongodb"
import { createValv, introspectMongo, type MongoDatabase } from "@valv/mongodb"
import type { DefaultContext, FieldSchema, RelationSchema, SchemaMap } from "@valv/core"

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
      fields: {
        _id: field("_id", "string", "objectId", {
          isId: true,
          isPrimaryKeyPart: true,
          hasDefaultValue: true,
        }),
        tenantId: field("tenantId", "string", "string"),
        customerId: field("customerId", "string", "objectId"),
        status: field("status", "string", "string"),
        total: field("total", "number", "double"),
        createdAt: field("createdAt", "date", "date"),
        metadata__source: field("metadata__source", "string", "string", {
          jsonPath: { column: "metadata", path: ["source"] },
        }),
        internalNotes: field("internalNotes", "string", "string", { sensitive: true }),
      },
      relations: {
        customer: {
          name: "customer",
          targetResource: "customers",
          type: "belongsTo",
          foreignKey: "customerId",
          targetKey: "_id",
        },
      },
    },
    customers: {
      name: "customers",
      tableName: "customers",
      relations: {
        orders: {
          name: "orders",
          targetResource: "orders",
          type: "hasMany",
          foreignKey: "customerId",
          targetKey: "_id",
        },
      },
      fields: {
        _id: field("_id", "string", "objectId", {
          isId: true,
          isPrimaryKeyPart: true,
          hasDefaultValue: true,
        }),
        tenantId: field("tenantId", "string", "string"),
        name: field("name", "string", "string"),
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
    fields: {
      allow: ["_id", "customerId", "status", "total", "createdAt", "metadata__source"],
    },
  }))
  valv.policy("customers", (context) => ({
    read: { tenantId: context.tenant!.id },
    fields: { allow: ["_id", "name"] },
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

  it("reads an allowlisted nested document field through trusted catalog metadata", async () => {
    const { valv, calls } = await setup()
    await valv.run(
      {
        from: "orders",
        select: { source: { col: "metadata__source" } },
        where: { metadata__source: { startsWith: "api" } },
      },
      ctx,
    )

    expect(JSON.stringify(calls[0].pipeline)).toContain("$metadata.source")
    expect(calls[0].pipeline.at(-1)).toEqual({
      $project: { _id: 0, source: { $ifNull: ["$metadata.source", null] } },
    })
  })

  it("compiles dateTrunc as a grouped expression", async () => {
    const { valv, calls } = await setup()
    await valv.run(
      {
        from: "orders",
        select: {
          month: { dateTrunc: ["createdAt", "month"] },
          revenue: { sum: "total" },
        },
        groupBy: ["month"],
        orderBy: { month: "asc" },
      },
      ctx,
    )

    expect(calls[0].pipeline[1]).toEqual({
      $group: {
        _id: { k0: { $dateTrunc: { date: "$createdAt", unit: "month" } } },
        revenue: { $sum: "$total" },
      },
    })
  })

  it("projects and orders by a row-level dateTrunc expression", async () => {
    const { valv, calls } = await setup()
    await valv.run(
      {
        from: "orders",
        select: { day: { dateTrunc: ["createdAt", "day"] }, status: true },
        orderBy: { day: "asc" },
      },
      ctx,
    )

    expect(calls[0].pipeline.slice(-4)).toEqual([
      { $set: { __valv_sort_0: { $dateTrunc: { date: "$createdAt", unit: "day" } } } },
      { $sort: { __valv_sort_0: 1 } },
      { $limit: 100 },
      {
        $project: {
          _id: 0,
          day: { $ifNull: [{ $dateTrunc: { date: "$createdAt", unit: "day" } }, null] },
          status: { $ifNull: ["$status", null] },
        },
      },
    ])
  })

  it("joins a declared relation and applies the related resource policy", async () => {
    const { valv, calls } = await setup()
    await valv.run(
      {
        from: "orders",
        select: { status: true, customer_name: { col: "customer.name" } },
      },
      ctx,
    )

    expect(calls[0].pipeline.slice(0, 2)).toEqual([
      {
        $lookup: {
          from: "customers",
          localField: "customerId",
          foreignField: "_id",
          as: "j_customer",
        },
      },
      { $unwind: { path: "$j_customer" } },
    ])
    expect(JSON.stringify(calls[0].pipeline[2])).toContain("$j_customer.tenantId")
    expect(calls[0].pipeline.at(-1)).toEqual({
      $project: {
        _id: 0,
        status: { $ifNull: ["$status", null] },
        customer_name: { $ifNull: ["$j_customer.name", null] },
      },
    })
  })

  it("orients an inverse hasMany lookup from the parent id to the child foreign key", async () => {
    const { valv, calls } = await setup()
    await valv.run(
      {
        from: "customers",
        select: { customer: { col: "name" }, order_status: { col: "orders.status" } },
      },
      ctx,
    )

    expect(calls[0].pipeline[0]).toEqual({
      $lookup: {
        from: "orders",
        localField: "_id",
        foreignField: "customerId",
        as: "j_orders",
      },
    })
  })

  it("blocks a relation before executing when the parent policy denies traversal", async () => {
    const { database, calls } = fakeDatabase()
    const valv = await createValv<DefaultContext>(database, {
      schema,
      defaultPolicy: "deny-all",
    })
    valv.policy("orders", (context) => ({
      read: { tenantId: context.tenant!.id },
      relations: { customer: false },
    }))
    valv.policy("customers", () => ({ read: true }))

    await expect(
      valv.run({ from: "orders", select: { customer_name: { col: "customer.name" } } }, ctx),
    ).rejects.toThrow(/Relation "customer" is not accessible/)
    expect(calls).toHaveLength(0)
  })

  it("coerces a nested ObjectId filter from trusted field metadata", async () => {
    const id = new ObjectId()
    const nestedSchema = structuredClone(schema)
    nestedSchema.resources.orders.fields.metadata__ownerId = field(
      "metadata__ownerId",
      "string",
      "objectId",
      { jsonPath: { column: "metadata", path: ["ownerId"] } },
    )
    const { database, calls } = fakeDatabase()
    const valv = await createValv<DefaultContext>(database, {
      schema: nestedSchema,
      defaultPolicy: "allow-all",
    })

    await valv.run(
      {
        from: "orders",
        select: { owner: { col: "metadata__ownerId" } },
        where: { metadata__ownerId: id.toHexString() },
      },
      ctx,
    )

    expect(findObjectId(calls[0].pipeline)?.toHexString()).toBe(id.toHexString())
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
                return [
                  {
                    _id: id,
                    tenantId: "acme",
                    total: 12.5,
                    metadata: { source: "api", device: { mobile: true } },
                  },
                ]
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
    expect(catalog.resources.orders.fields.metadata__source).toMatchObject({
      type: "string",
      jsonPath: { column: "metadata", path: ["source"] },
    })
    expect(catalog.resources.orders.fields.metadata__device__mobile).toMatchObject({
      type: "boolean",
      jsonPath: { column: "metadata", path: ["device", "mobile"] },
    })
    expect(catalog.resources.orders.fields.metadata).toBeUndefined()
  })

  it("merges declared cross-collection relations into the introspected catalog", async () => {
    const relation: RelationSchema = {
      name: "customer",
      targetResource: "customers",
      type: "belongsTo",
      foreignKey: "customerId",
      targetKey: "_id",
    }
    const database: MongoDatabase = {
      listCollections() {
        return {
          async toArray() {
            return [
              { name: "orders", type: "collection" },
              { name: "customers", type: "collection" },
            ]
          },
        }
      },
      collection(name) {
        return {
          aggregate() {
            return {
              async toArray() {
                return name === "orders"
                  ? [{ _id: new ObjectId(), customerId: new ObjectId() }]
                  : [{ _id: new ObjectId(), name: "Acme" }]
              },
            }
          },
        }
      },
    }

    const catalog = await introspectMongo(database, {
      relations: { orders: { customer: relation } },
    })

    expect(catalog.resources.orders.relations.customer).toEqual(relation)
  })

  it("keeps a physical field when its name collides with a generated nested name", async () => {
    const database: MongoDatabase = {
      listCollections() {
        return {
          async toArray() {
            return [{ name: "events", type: "collection" }]
          },
        }
      },
      collection() {
        return {
          aggregate() {
            return {
              async toArray() {
                return [{ metadata__source: "physical", metadata: { source: "nested" } }]
              },
            }
          },
        }
      },
    }

    const catalog = await introspectMongo(database)

    expect(catalog.resources.events.fields.metadata__source.jsonPath).toBeUndefined()
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
