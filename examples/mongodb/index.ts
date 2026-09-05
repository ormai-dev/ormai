import "dotenv/config"
import type { DefaultContext } from "@valv/core"
import { createValvFromUrl } from "@valv/mongodb"

const databaseUrl = process.env.DATABASE_URL ?? "mongodb://localhost:27017"
const databaseName = process.env.MONGODB_DATABASE ?? "analytics"
const tenantId = process.env.TENANT_ID ?? "tenant-alpha"

async function main(): Promise<void> {
  const { valv, stop } = await createValvFromUrl<DefaultContext>(databaseUrl, {
    database: databaseName,
    defaultPolicy: "deny-all",
    relations: {
      orders: {
        customer: {
          name: "customer",
          targetResource: "customers",
          type: "belongsTo",
          foreignKey: "customerId",
          targetKey: "_id",
        },
      },
    },
  })

  try {
    valv.policy("orders", (context) => ({
      read: { tenantId: context.tenant!.id },
      fields: {
        allow: ["_id", "customerId", "status", "total", "metadata__source", "createdAt"],
      },
    }))
    valv.policy("customers", (context) => ({
      read: { tenantId: context.tenant!.id },
      fields: { allow: ["_id", "name"] },
    }))

    const context: DefaultContext = {
      user: { id: "demo-user", role: "analyst" },
      tenant: { id: tenantId },
    }

    const rows = await valv.run(
      {
        from: "orders",
        select: {
          customer: { col: "customer.name" },
          status: true,
          month: { dateTrunc: ["createdAt", "month"] },
          source: { col: "metadata__source" },
          revenue: { sum: "total" },
          orders: { count: true },
        },
        groupBy: ["customer.name", "status", "month", "metadata__source"],
        orderBy: { revenue: "desc" },
      },
      context,
    )

    console.table(rows)
  } finally {
    await stop()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
