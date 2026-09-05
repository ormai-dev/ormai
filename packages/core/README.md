# @valv/core

The database-agnostic core of [valv](../../README.md): the query grammar an LLM emits, the validator that checks it against your schema and policy, the policy injector, the shared SQL emitter, and the tool layer. Adapters receive a validated, policy-injected query and decide how to compile and execute it.

[![npm](https://img.shields.io/npm/v/@valv/core)](https://www.npmjs.com/package/@valv/core) [![license](https://img.shields.io/npm/l/@valv/core)](../../LICENSE)

> **Most users install an adapter, not this package directly** — [`@valv/clickhouse`](../clickhouse), [`@valv/mongodb`](../mongodb), or [`@valv/prisma`](../prisma) wrap core with introspection and database execution. See the [root README](../../README.md) for the full guide. Reach for `@valv/core` directly only to build a custom adapter.

## What this package exports

| Area | Exports |
|---|---|
| Orchestration | `Valv` (instantiated by adapters via `createValv`) |
| Query grammar | `QuerySchema`; types `Query`, `Expr`, `SelectItem` |
| Write grammar | `InsertSchema`, `UpdateSchema`, `DeleteSchema`; types `Insert`, `Update`, `Delete`, `InjectedMutation` |
| Policy | `PolicyFn`, `PolicyResult`, `FieldPolicy`, `DefaultContext` |
| Emission | `emit`, `emitInsert`/`emitUpdate`/`emitDelete`, the `Dialect` interface, `BASE_FUNCTIONS`, `FnDef`, `ArgSpec` |
| Output shape | `resultSchema`, `ResultColumn` |
| Tool formats | `anthropic`, `openai`, `gemini` formatters; `NeutralTool`, `ToolToggle` |
| Adapter contract | `ValvAdapter`, `SchemaMap`, `CompiledQuery`, `BoundParam`, `MutationResult` |
| Errors | `ValidationError`, `PolicyViolationError`; `serializeResult` |

## Building an adapter

Everything above database execution is shared. An adapter introspects the database, advertises its functions, and runs a validated, policy-injected query. SQL adapters can use the shared `emit` function and a small `Dialect`; non-SQL adapters can compile the query into their native command format.

```ts
import type { ValvAdapter, SchemaMap, Query, FnDef, Dialect } from "@valv/core"
import { emit, BASE_FUNCTIONS } from "@valv/core"

const myDialect: Dialect = {
  quoteId: (id) => `"${id.replace(/"/g, '""')}"`,
  placeholder: (i) => `$${i + 1}`,
  // functions: { ...dialect-specific aggregates }
}

class MyAdapter implements ValvAdapter {
  async introspect(): Promise<SchemaMap> {
    // describe your tables → resources, fields (with coarse `type` + `nativeType`), relations
  }
  async run(query: Query, catalog: SchemaMap): Promise<unknown[]> {
    const compiled = emit(query, catalog, myDialect)
    // Run compiled.sql with compiled.params and return rows.
    return database.query(compiled.sql, compiled.params.map((param) => param.value))
  }
  functions(): Record<string, FnDef> {
    return { ...BASE_FUNCTIONS, ...myDialect.functions }
  }
  // Optional — implement to support writes. The mutation is already validated
  // and policy-injected; emit it with emitInsert/emitUpdate/emitDelete and run it.
  // mutate?(m: InjectedMutation, catalog: SchemaMap): Promise<MutationResult>
}
```

Policy functions and caller context never reach the adapter. Core evaluates them, validates the query, and injects their predicates before calling `run`. A `Dialect` can also declare extra functions (`FnDef`: argument signature, return type, render), which become callable in the query grammar and are surfaced to the model through the `query` tool's enum. Writes are optional: implement `mutate` (the mutation arrives already validated and policy-injected) to opt in, or omit it for a read-only adapter.

## Type-safe resource names

`InferResources` derives resource names from a typed client, so a misspelled policy key is a compile error:

```ts
import type { InferResources } from "@valv/core"
const valv = await createValv<typeof prisma, Ctx>(prisma)  // policy keys autocomplete
```

## License

MIT
