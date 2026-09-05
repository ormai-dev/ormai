# MongoDB example

This small example introspects a MongoDB collection, applies a tenant policy,
and compiles a grouped Valv query into an aggregation pipeline.

The seed data includes a large order for `tenant-beta`. Run the query as
`tenant-alpha` and that order is excluded before grouping. The policy also uses
an explicit field allowlist, so `internalNotes` cannot be selected.

## Run it

Run these commands from this directory:

```bash
cp .env.example .env
npm run db:start
npm run db:seed
npm start
```

The result should contain `tenant-alpha` totals only:

```text
status   revenue  orders
paid     200      2
pending  40       1
```

Use `npm run db:stop` when you are finished. The example uses MongoDB 8.2 in a
local Docker container named `valv-mongodb`.

> MongoDB support is experimental. The adapter currently supports read queries
> on one collection at a time; relation traversal and writes are not available.
