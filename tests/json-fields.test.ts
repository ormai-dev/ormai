import { describe, it, expect } from "vitest"
import { Valv, emit, BASE_FUNCTIONS } from "@valv/core"
import type {
  ValvAdapter,
  SchemaMap,
  Query,
  CompiledQuery,
  DefaultContext,
  Dialect,
  FieldSchema,
} from "@valv/core"

// A field with a `jsonPath` is exposed and gated by its logical name exactly like
// a physical column — the allowlist, sensitivity, and policy machinery are
// untouched. Only its emitted SQL differs: a dialect JSON extraction from the
// source column. These tests pin both halves: the SQL shape and that the security
// gate treats a JSON field like any other.

const f = (
  name: string,
  type: FieldSchema["type"],
  nativeType: string,
  extra: Partial<FieldSchema> = {},
): FieldSchema => ({ name, type, nativeType, isNullable: true, isId: false, ...extra })

// Postgres-style JSON extraction: -> to descend, ->> for the leaf, cast non-text.
const pgJson: Dialect = {
  quoteId: (id) => `"${id}"`,
  placeholder: (i) => `$${i + 1}`,
  jsonExtract: (columnRef, path, type) => {
    const steps = path.map((k, i) => `${i === path.length - 1 ? "->>" : "->"} '${k}'`).join(" ")
    const expr = `(${columnRef} ${steps})`
    return type === "String" ? expr : `${expr}::${type}`
  },
}

const schema: SchemaMap = {
  resources: {
    events: {
      name: "events",
      tableName: "events",
      relations: {
        person: {
          name: "person",
          targetResource: "persons",
          type: "belongsTo",
          foreignKey: "person_id",
          targetKey: "id",
        },
      },
      fields: {
        event: f("event", "string", "String"),
        person_id: f("person_id", "uuid", "UUID"),
        properties: f("properties", "json", "JSON"),
        browser: f("browser", "string", "String", {
          jsonPath: { column: "properties", path: ["$browser"] },
        }),
        loaded_ms: f("loaded_ms", "number", "Int64", {
          jsonPath: { column: "properties", path: ["timing", "load"] },
        }),
        email: f("email", "string", "String", {
          sensitive: true,
          jsonPath: { column: "properties", path: ["$email"] },
        }),
      },
    },
    persons: {
      name: "persons",
      tableName: "persons",
      relations: {},
      fields: {
        id: f("id", "uuid", "UUID", { isId: true, isNullable: false }),
        properties: f("properties", "json", "JSON"),
        country: f("country", "string", "String", {
          jsonPath: { column: "properties", path: ["$geoip_country_name"] },
        }),
      },
    },
  },
}

const ctx: DefaultContext = { user: { id: "u1", role: "member" } }

async function valvFor(dialect: Dialect) {
  let last: CompiledQuery | undefined
  const adapter: ValvAdapter = {
    async introspect() {
      return schema
    },
    async run(q: Query, cat) {
      last = emit(q, cat, dialect)
      return []
    },
    functions() {
      return { ...BASE_FUNCTIONS }
    },
  }
  const valv = new Valv<DefaultContext>({ adapter, defaultPolicy: "allow-all" })
  await valv.loadSchema()
  return { valv, sql: () => last!.sql, params: () => last!.params }
}

async function run(valv: Valv<DefaultContext>, query: unknown) {
  await valv.runTool("query", query, ctx)
}

describe("json-path fields", () => {
  it("emits a single-key extraction, aliased to the logical name", async () => {
    const { valv, sql } = await valvFor(pgJson)
    await run(valv, { from: "events", select: { browser: true } })
    expect(sql()).toContain(`("properties" ->> '$browser') AS "browser"`)
  })

  it("descends a nested path and casts to the field's native type", async () => {
    const { valv, sql, params } = await valvFor(pgJson)
    await run(valv, {
      from: "events",
      select: { event: true },
      where: { loaded_ms: { gt: 500 } },
    })
    expect(sql()).toContain(`("properties" -> 'timing' ->> 'load')::Int64 > $1`)
    // Param is typed by the field, not defaulted to String.
    expect(params()[0]).toEqual({ value: 500, type: "Int64" })
  })

  it("alias-qualifies the source column of a joined json field", async () => {
    const { valv, sql } = await valvFor(pgJson)
    await run(valv, {
      from: "events",
      select: { event: true, person_country: { col: "person.country" } },
    })
    expect(sql()).toContain(
      `("j_person"."properties" ->> '$geoip_country_name') AS "person_country"`,
    )
  })

  it("rejects a sensitive json field, same as a sensitive column", async () => {
    const { valv } = await valvFor(pgJson)
    await expect(run(valv, { from: "events", select: { email: true } })).rejects.toThrow(
      /not accessible/,
    )
  })

  it("honors a policy field deny on a json field", async () => {
    const { valv } = await valvFor(pgJson)
    valv.policy("events", () => ({ read: {}, fields: { deny: ["browser"] } }))
    await expect(run(valv, { from: "events", select: { browser: true } })).rejects.toThrow(
      /not accessible/,
    )
  })

  it("fails closed when the dialect can't extract json", async () => {
    const noJson: Dialect = { quoteId: (id) => `"${id}"`, placeholder: (i) => `$${i + 1}` }
    const { valv } = await valvFor(noJson)
    await expect(run(valv, { from: "events", select: { browser: true } })).rejects.toThrow()
  })
})
