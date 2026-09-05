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
  })

  try {
    valv.policy("orders", (context) => ({
      read: { tenantId: context.tenant!.id },
      fields: { allow: ["_id", "status", "total", "createdAt"] },
    }))

    const context: DefaultContext = {
      user: { id: "demo-user", role: "analyst" },
      tenant: { id: tenantId },
    }

    const rows = await valv.run(
      {
        from: "orders",
        select: {
          status: true,
          revenue: { sum: "total" },
          orders: { count: true },
        },
        groupBy: ["status"],
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
