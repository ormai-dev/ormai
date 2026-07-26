import type { SchemaMap, ResourceSchema, FieldSchema, FieldType, RelationSchema } from "@valv/core"
import { toDriver, type Driver, type PostgresClient } from "./driver"

interface ColumnRow {
  table_name: string
  column_name: string
  data_type: string
  is_nullable: string
  has_default: boolean
}

interface PkRow {
  table_name: string
  column_name: string
}

interface FkRow {
  table_name: string
  column_name: string
  constraint_name: string
  foreign_table_name: string
  foreign_column_name: string
}

// Introspect a single Postgres schema (`namespace`, default `public`). Resource
// names are the bare table name; when a non-default namespace is used the adapter
// qualifies emitted tables as `"namespace"."table"` (via emit's `database`
// option). Still single-schema: `resources[tableName]` keying and FK matching
// assume table names are unique within the introspected namespace. `namespace` is
// a trusted config value (never user input), so inlining it into the SQL adds no
// injection surface — same as the old hardcoded constant.
export function introspectPostgres(
  client: PostgresClient,
  namespace = "public",
): Promise<SchemaMap> {
  return introspectWithDriver(toDriver(client), namespace)
}

/**
 * The same introspection against an already-normalised driver, so the adapter
 * doesn't re-derive one per call. Introspection reads the catalog and needs none
 * of the session scoping the adapter applies to model-driven queries, so every
 * statement here goes through plain `query`.
 */
export async function introspectWithDriver(
  driver: Driver,
  namespace = "public",
): Promise<SchemaMap> {
  const [columns, pks, fks] = await Promise.all([
    driver.query(`
      select c.table_name, c.column_name, c.data_type, c.is_nullable,
             (c.column_default is not null) as has_default
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
      where t.table_type = 'BASE TABLE' and c.table_schema = '${namespace}'
      order by c.table_name, c.ordinal_position
    `) as Promise<ColumnRow[]>,
    // Primary keys from pg_catalog, not information_schema.table_constraints:
    // that view is empty for a SELECT-only role that doesn't own the table (it
    // requires ownership or a non-SELECT privilege), and valv connections are
    // read-only by design — so PKs would silently vanish. pg_catalog is readable
    // by any role, so keys resolve regardless of grants.
    driver.query(`
      select c.relname as table_name, a.attname as column_name
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      join lateral unnest(con.conkey) with ordinality as k(attnum, ord) on true
      join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
      where con.contype = 'p' and n.nspname = '${namespace}'
      order by c.relname, k.ord
    `) as Promise<PkRow[]>,
    // Foreign keys from pg_catalog for the same reason. unnest with ordinality
    // over both key arrays at once keeps local and referenced columns paired in
    // order, so composite FKs group correctly.
    driver.query(`
      select c.relname as table_name, a.attname as column_name, con.conname as constraint_name,
             fc.relname as foreign_table_name, fa.attname as foreign_column_name
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_class fc on fc.oid = con.confrelid
      join lateral unnest(con.conkey, con.confkey) with ordinality as k(conkey, confkey, ord) on true
      join pg_attribute a on a.attrelid = c.oid and a.attnum = k.conkey
      join pg_attribute fa on fa.attrelid = fc.oid and fa.attnum = k.confkey
      where con.contype = 'f' and n.nspname = '${namespace}'
      order by c.relname, con.conname, k.ord
    `) as Promise<FkRow[]>,
  ])

  const pkByTable = new Map<string, string[]>()
  for (const r of pks) {
    const list = pkByTable.get(r.table_name) ?? []
    list.push(r.column_name)
    pkByTable.set(r.table_name, list)
  }

  // Group FK columns by constraint so composite FKs (>1 column) can be detected
  // and skipped — valv relations carry a single join key, so a composite FK
  // can't be represented and is dropped rather than emitted wrong.
  const fkByConstraint = new Map<
    string,
    { table: string; localColumns: string[]; foreignTable: string; foreignColumns: string[] }
  >()
  for (const r of fks) {
    const entry = fkByConstraint.get(r.constraint_name) ?? {
      table: r.table_name,
      localColumns: [],
      foreignTable: r.foreign_table_name,
      foreignColumns: [],
    }
    entry.localColumns.push(r.column_name)
    entry.foreignColumns.push(r.foreign_column_name)
    fkByConstraint.set(r.constraint_name, entry)
  }

  const columnsByTable = new Map<string, ColumnRow[]>()
  for (const r of columns) {
    const list = columnsByTable.get(r.table_name) ?? []
    list.push(r)
    columnsByTable.set(r.table_name, list)
  }

  const resources: Record<string, ResourceSchema> = {}
  for (const [tableName, cols] of columnsByTable) {
    const pkCols = pkByTable.get(tableName) ?? []
    // Prefer a column literally named "id", else the sole primary key column.
    const idCol = cols.find((c) => c.column_name === "id")?.column_name ?? pkCols[0]

    const fields: Record<string, FieldSchema> = {}
    for (const col of cols) {
      const type = mapPgType(col.data_type)
      if (!type) continue
      fields[col.column_name] = {
        name: col.column_name,
        type,
        nativeType: col.data_type,
        isNullable: col.is_nullable === "YES",
        isId: col.column_name === idCol,
        isPrimaryKeyPart: pkCols.includes(col.column_name),
        hasDefaultValue: col.has_default,
      }
    }

    resources[tableName] = { name: tableName, tableName, fields, relations: {} }
  }

  addRelations(resources, fkByConstraint)
  return { resources }
}

// Turn single-column FK constraints into relations on both ends: a `belongsTo`
// on the table that owns the FK, and the inverse `hasMany` on the referenced
// table — so the model can traverse orders → customer and customer → orders.
function addRelations(
  resources: Record<string, ResourceSchema>,
  fkByConstraint: Map<
    string,
    { table: string; localColumns: string[]; foreignTable: string; foreignColumns: string[] }
  >,
): void {
  for (const fk of fkByConstraint.values()) {
    if (fk.localColumns.length !== 1) continue // composite FK — not representable
    const localColumn = fk.localColumns[0]
    const foreignColumn = fk.foreignColumns[0]
    const owner = resources[fk.table]
    const target = resources[fk.foreignTable]
    if (!owner || !target) continue

    const belongsToName = uniqueName(
      owner.relations,
      localColumn.endsWith("_id") ? localColumn.slice(0, -3) : fk.foreignTable,
    )
    owner.relations[belongsToName] = {
      name: belongsToName,
      targetResource: fk.foreignTable,
      type: "belongsTo",
      foreignKey: localColumn,
      targetKey: foreignColumn,
    }

    const hasManyName = uniqueName(target.relations, pluralize(fk.table))
    target.relations[hasManyName] = {
      name: hasManyName,
      targetResource: fk.table,
      type: "hasMany",
      // For hasMany the FK lives on the owning (child) table; targetKey is the
      // referenced column back on this (parent) table.
      foreignKey: localColumn,
      targetKey: foreignColumn,
    }
  }
}

function uniqueName(existing: Record<string, RelationSchema>, base: string): string {
  if (!(base in existing)) return base
  let n = 2
  while (`${base}_${n}` in existing) n++
  return `${base}_${n}`
}

function pluralize(name: string): string {
  return name.endsWith("s") ? name : `${name}s`
}

// Coarse cross-dialect type from Postgres's information_schema data_type. Unknown
// types (composite, geometry, and — for now — enums, which surface as
// USER-DEFINED without their values here) fall through to "string".
function mapPgType(dataType: string): FieldType | null {
  const t = dataType.toLowerCase()
  if (
    [
      "smallint",
      "integer",
      "bigint",
      "decimal",
      "numeric",
      "real",
      "double precision",
      "money",
    ].includes(t)
  )
    return "number"
  if (t === "boolean") return "boolean"
  if (t === "uuid") return "uuid"
  if (t === "date" || t.startsWith("timestamp") || t.startsWith("time")) return "date"
  if (t === "json" || t === "jsonb") return "json"
  return "string"
}
