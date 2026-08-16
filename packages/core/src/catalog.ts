// The Catalog: the database shape valv discovers via introspection. Adapters
// produce a SchemaMap; the query path validates and emits against it.

export interface SchemaMap {
  resources: Record<string, ResourceSchema>
}

export interface ResourceSchema {
  name: string // logical snake_case name, e.g. "orders"
  tableName: string // real table name, e.g. "Order"
  fields: Record<string, FieldSchema>
  relations: Record<string, RelationSchema>
  description?: string
  // A relation that can be read but not written — a database view or
  // materialized view. Reads validate and emit like any resource; writes are
  // rejected up front (a view has no single writable table behind it).
  readOnly?: boolean
}

export type FieldType = "string" | "number" | "boolean" | "date" | "enum" | "uuid" | "json"

export interface FieldSchema {
  name: string
  type: FieldType // coarse, cross-dialect semantic type
  nativeType: string // the database's own type, e.g. "UInt32", "VarChar(255)" — used to emit typed params
  isNullable: boolean
  isId: boolean
  isPrimaryKeyPart?: boolean // part of the primary/sort key — used for query cost limits
  hasDefaultValue?: boolean // has a DB/schema default, e.g. @default(now())
  enumValues?: string[] // when type is "enum"
  description?: string
  sensitive?: boolean // stripped from the model's view before policy runs
  // Marks the field as a value extracted from a JSON column, not a physical column.
  // Allowlisted and policy-gated by `name` like any field; only its emitted SQL
  // differs. `path` is catalog-authored (never model input), so nested keys are
  // exposed one at a time. Needs a dialect with `jsonExtract` or it fails at emit.
  jsonPath?: { column: string; path: string[] }
}

export interface RelationSchema {
  name: string
  targetResource: string
  type: "belongsTo" | "hasMany" | "manyToMany"
  // The join keys, oriented by `type`:
  //   belongsTo — `foreignKey` is the local FK on this resource; `targetKey` is
  //               the referenced column on the target (≈ the target's id).
  //   hasMany   — `foreignKey` is the FK on the *target* pointing back here;
  //               `targetKey` is this resource's referenced column (≈ its id).
  // Auto-introspected for Prisma; for hand-defined schemas (e.g. ClickHouse,
  // which has no FKs) the developer sets both so joins can resolve.
  foreignKey: string
  targetKey?: string
  junctionTable?: string // for manyToMany
}

// camelCase → snake_case at the type level, so resource names inferred from a
// Prisma client match the snake_case keys valv uses.
type CamelToSnake<S extends string> = S extends `${infer Head}${infer Tail}`
  ? Head extends Uppercase<Head>
    ? Head extends Lowercase<Head>
      ? `${Head}${CamelToSnake<Tail>}`
      : `_${Lowercase<Head>}${CamelToSnake<Tail>}`
    : `${Head}${CamelToSnake<Tail>}`
  : S

/**
 * Resource names (snake_case) derived from a Prisma client type, giving
 * policy() and tools.* autocomplete.
 *
 * @example
 * const valv = new Valv<DefaultContext, InferResources<typeof prisma>>({ ... })
 */
export type InferResources<TClient> = CamelToSnake<
  Exclude<keyof TClient, `$${string}` | symbol | number> & string
>
