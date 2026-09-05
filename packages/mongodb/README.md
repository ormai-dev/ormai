# @valv/mongodb

`@valv/mongodb` connects Valv to MongoDB through the official Node.js driver.
It introspects collections, applies Valv policies, and compiles the shared query
grammar into MongoDB aggregation pipelines.

<!-- prettier-ignore -->
> [!NOTE]
> This is an experimental feature currently under active development.

The adapter is read-only. It supports top-level fields, nested document fields,
declared `belongsTo` and `hasMany` relations, filters, projection, sorting,
pagination, the base aggregate functions, and `dateTrunc`. Writes are not
available.

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
  fields: {
    allow: ["_id", "customerId", "status", "total", "metadata__source", "createdAt"],
  },
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

## Nested document fields

Embedded objects are flattened into catalog fields with `__` between path
segments. A document `{ metadata: { source: "api" } }` exposes
`metadata__source`. Intermediate objects are not themselves selectable.

Query the flattened name. Valv compiles it to the dotted BSON path:

```ts
await valv.run(
  {
    from: "orders",
    select: { source: { col: "metadata__source" } },
    where: { metadata__source: { startsWith: "api" } },
  },
  ctx,
)
```

If a physical top-level field uses the same name as a generated nested field,
the physical field wins. The nested path stays inaccessible so one policy name
cannot refer to two BSON values.

## Relations

MongoDB has no foreign-key metadata to introspect, so you declare relations
when you create the instance. Pass them to `createValv` or
`createValvFromUrl`. `belongsTo` and `hasMany` are supported. `manyToMany` is
not.

```ts
const { valv, stop } = await createValvFromUrl(process.env.DATABASE_URL!, {
  database: "analytics",
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
```

For a hand-defined schema, put the same relation objects on each resource
instead of passing `relations`.

A dotted path in the query follows the relation. Valv compiles it to `$lookup`
plus `$unwind`, then applies the related resource's policy:

```ts
valv.policy("orders", (ctx) => ({
  read: { tenantId: ctx.tenant.id },
  fields: { allow: ["_id", "customerId", "status", "total", "createdAt"] },
}))
valv.policy("customers", (ctx) => ({
  read: { tenantId: ctx.tenant.id },
  fields: { allow: ["_id", "name"] },
}))

await valv.run(
  {
    from: "orders",
    select: {
      customer: { col: "customer.name" },
      status: true,
      revenue: { sum: "total" },
    },
    groupBy: ["customer.name", "status"],
  },
  ctx,
)
```

The lookup is an inner join. A missing related document, or one that fails the
joined resource's policy, drops the parent row.

See [`examples/mongodb`](../../examples/mongodb) for a tenant-scoped query that
joins `orders` to `customers`, reads `metadata.source`, and buckets by month.

## MongoDB functions

On top of the standard aggregates (`count`, `sum`, `avg`, `min`, `max`), this
dialect adds `dateTrunc`:

| Function | Use |
|---|---|
| `dateTrunc(col, unit)` | Bucket a date. `unit` is `minute`, `hour`, `day`, `month`, or `year`. |

```ts
{
  from: "orders",
  select: {
    month: { dateTrunc: ["createdAt", "month"] },
    revenue: { sum: "total" },
  },
  groupBy: ["month"],
}
```

## License

MIT
