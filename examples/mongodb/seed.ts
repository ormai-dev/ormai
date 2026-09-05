import "dotenv/config"
import { MongoClient } from "mongodb"

const client = new MongoClient(process.env.DATABASE_URL ?? "mongodb://localhost:27017")
const databaseName = process.env.MONGODB_DATABASE ?? "analytics"

async function seed(): Promise<void> {
  await client.connect()
  const db = client.db(databaseName)

  const existing = await db.listCollections({ name: "orders" }).hasNext()
  if (existing) await db.collection("orders").drop()

  await db.createCollection("orders", {
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["tenantId", "status", "total", "createdAt"],
        properties: {
          tenantId: { bsonType: "string" },
          status: { bsonType: "string" },
          total: { bsonType: ["int", "long", "double", "decimal"] },
          internalNotes: { bsonType: "string" },
          createdAt: { bsonType: "date" },
        },
      },
    },
  })

  await db.collection("orders").insertMany([
    {
      tenantId: "tenant-alpha",
      status: "paid",
      total: 125,
      internalNotes: "Priority customer",
      createdAt: new Date("2026-01-03T10:00:00Z"),
    },
    {
      tenantId: "tenant-alpha",
      status: "paid",
      total: 75,
      internalNotes: "",
      createdAt: new Date("2026-01-04T10:00:00Z"),
    },
    {
      tenantId: "tenant-alpha",
      status: "pending",
      total: 40,
      internalNotes: "Review before shipping",
      createdAt: new Date("2026-01-05T10:00:00Z"),
    },
    {
      tenantId: "tenant-beta",
      status: "paid",
      total: 10_000,
      internalNotes: "Must not appear in tenant-alpha results",
      createdAt: new Date("2026-01-06T10:00:00Z"),
    },
  ])

  console.log(`Seeded ${databaseName}.orders`)
}

seed()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => client.close())
