# MongoDB example

This example introspects MongoDB collections, exposes nested document fields,
declares a cross-collection relation, applies tenant policies to both sides of
the relation, and compiles a grouped Valv query into an aggregation pipeline.

The seed data includes a large order and customer for `tenant-beta`. It also
includes a `tenant-alpha` order that points at the `tenant-beta` customer. Run
the query as `tenant-alpha` and Valv excludes both cases before grouping. This
tests the root and joined-resource policies independently. The policy also uses
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
customer  status   month                     source  revenue  orders
Acme      paid     2026-01-01T00:00:00.000Z  api     200      2
Acme      pending  2026-01-01T00:00:00.000Z  api     40       1
```

Use `npm run db:stop` when you are finished. The example uses MongoDB 8.2 in a
local Docker container named `valv-mongodb`.

<!-- prettier-ignore -->
> [!NOTE]
> This is an experimental feature currently under active development.

The adapter supports read queries, declared relations, and nested document
fields. Writes are not available.
