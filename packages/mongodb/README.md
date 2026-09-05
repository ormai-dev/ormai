# @valv/mongodb

`@valv/mongodb` connects Valv to MongoDB through the official Node.js driver.
It introspects collections, applies Valv policies, and compiles the shared query
grammar into MongoDB aggregation pipelines.

<!-- prettier-ignore -->
> [!NOTE]
> This is an experimental feature currently under active development.

The current adapter is read-only and supports top-level fields, filters,
projection, sorting, pagination, and the base aggregate functions.
Cross-collection relations and writes are not supported yet.

## Install

Install the adapter and the MongoDB driver:

```bash
npm install @valv/mongodb mongodb
```

## Connect

Pass a connected MongoDB `Db` and let Valv introspect its collections:

```ts
import { MongoClient } from "mongodb"
import { createValv } from "@valv/mongodb"

const client = new MongoClient(process.env.DATABASE_URL!)
await client.connect()

const valv = await createValv(client.db("analytics"), {
  schema: "introspect",
  defaultPolicy: "deny-all",
})

valv.policy("orders", (ctx) => ({
  read: { tenantId: ctx.tenant.id },
  fields: { allow: ["_id", "status", "total", "createdAt"] },
}))
```

MongoDB introspection merges collection `$jsonSchema` validators with a sample
of existing documents. Use field allowlists for collections whose document
shape can change. New or unsampled fields remain inaccessible until they enter
the catalog and the policy explicitly allows them.

You can also connect from a URL:

```ts
import { createValvFromUrl } from "@valv/mongodb"

const { valv, stop } = await createValvFromUrl(process.env.DATABASE_URL!, {
  database: "analytics",
  defaultPolicy: "deny-all",
})
```

Call `stop()` when the process no longer needs the connection.
