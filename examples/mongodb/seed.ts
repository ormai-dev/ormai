import "dotenv/config"
import { MongoClient, ObjectId } from "mongodb"

const client = new MongoClient(process.env.DATABASE_URL ?? "mongodb://localhost:27017")
const databaseName = process.env.MONGODB_DATABASE ?? "analytics"

async function seed(): Promise<void> {
  await client.connect()
  const db = client.db(databaseName)

  for (const name of ["orders", "customers"]) {
    if (await db.listCollections({ name }).hasNext()) await db.collection(name).drop()
  }

  await db.createCollection("customers", {
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["tenantId", "name"],
        properties: {
          tenantId: { bsonType: "string" },
          name: { bsonType: "string" },
        },
      },
    },
  })

  await db.createCollection("orders", {
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["tenantId", "customerId", "status", "total", "metadata", "createdAt"],
        properties: {
          tenantId: { bsonType: "string" },
          customerId: { bsonType: "objectId" },
          status: { bsonType: "string" },
          total: { bsonType: ["int", "long", "double", "decimal"] },
          internalNotes: { bsonType: "string" },
          metadata: {
            bsonType: "object",
            required: ["source"],
            properties: {
              source: { bsonType: "string" },
              device: {
                bsonType: "object",
                properties: { mobile: { bsonType: "bool" } },
              },
            },
          },
          createdAt: { bsonType: "date" },
        },
      },
    },
  })

  const alphaCustomerId = new ObjectId("0000000000000000000000a1")
  const betaCustomerId = new ObjectId("0000000000000000000000b1")
  await db.collection("customers").insertMany([
    { _id: alphaCustomerId, tenantId: "tenant-alpha", name: "Acme" },
    { _id: betaCustomerId, tenantId: "tenant-beta", name: "Globex" },
  ])

  await db.collection("orders").insertMany([
    {
      tenantId: "tenant-alpha",
      customerId: alphaCustomerId,
      status: "paid",
      total: 125,
      internalNotes: "Priority customer",
      metadata: { source: "api", device: { mobile: false } },
      createdAt: new Date("2026-01-03T10:00:00Z"),
    },
    {
      tenantId: "tenant-alpha",
      customerId: alphaCustomerId,
      status: "paid",
      total: 75,
      internalNotes: "",
      metadata: { source: "api", device: { mobile: true } },
      createdAt: new Date("2026-01-04T10:00:00Z"),
    },
    {
      tenantId: "tenant-alpha",
      customerId: alphaCustomerId,
      status: "pending",
      total: 40,
      internalNotes: "Review before shipping",
      metadata: { source: "api", device: { mobile: false } },
      createdAt: new Date("2026-01-05T10:00:00Z"),
    },
    {
      tenantId: "tenant-beta",
      customerId: betaCustomerId,
      status: "paid",
      total: 10_000,
      internalNotes: "Must not appear in tenant-alpha results",
      metadata: { source: "api", device: { mobile: false } },
      createdAt: new Date("2026-01-06T10:00:00Z"),
    },
    {
      tenantId: "tenant-alpha",
      customerId: betaCustomerId,
      status: "paid",
      total: 5_000,
      internalNotes: "Cross-tenant reference used to test relation policy composition",
      metadata: { source: "api", device: { mobile: false } },
      createdAt: new Date("2026-01-07T10:00:00Z"),
    },
  ])

  console.log(`Seeded ${databaseName}.customers and ${databaseName}.orders`)
}

seed()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => client.close())
