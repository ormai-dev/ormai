import type { SchemaMap, ResourceSchema, FieldSchema, FieldType, RelationSchema } from "@valv/core"

// The structural slice of a better-sqlite3 `Database` this adapter needs:
// `prepare(sql).all(...params)` returning plain row objects. The package never
// imports better-sqlite3 — the consumer passes their own handle (and owns its
// lifecycle and file path). node:sqlite's DatabaseSync satisfies this shape too.
//
// better-sqlite3 is synchronous by design, so unlike the Postgres and MySQL
// adapters there is no connection or pool to reserve: one handle serves every
// query, and there are no session settings that could leak between callers.
export interface SqliteClient {
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
}

function rows<T>(client: SqliteClient, sql: string, params: unknown[] = []): T[] {
  return client.prepare(sql).all(...params) as T[]
}

// SQLite identifiers are quoted with doubled double-quotes, same as the dialect.
// Table names here come from sqlite_master (the database's own catalog, never
// user input), but PRAGMA arguments can't be parameterised, so they are quoted
// rather than interpolated bare.
function quote(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"'
}

interface TableRow {
  name: string
}

// PRAGMA table_info: one row per column. `pk` is the column's 1-based position
// in the primary key (0 when it isn't part of one), so it doubles as both the
// membership flag and the ordering for composite keys.
interface ColumnRow {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

// PRAGMA foreign_key_list: one row per column of each FK. `id` groups the
// columns of a single constraint and `seq` orders them, which is how composite
// foreign keys are detected. `to` is null when the FK targets the parent's
// primary key implicitly rather than naming a column.
interface FkRow {
  id: number
  seq: number
  table: string
  from: string
  to: string | null
}

export function introspectSqlite(client: SqliteClient): SchemaMap {
  // Exclude SQLite's internal bookkeeping tables (sqlite_sequence, the
  // sqlite_stat* analyse tables) — they are implementation detail, not app data.
  const tables = rows<TableRow>(
    client,
    `select name from sqlite_master
     where type = 'table' and name not like 'sqlite_%'
     order by name`,
  )

  const resources: Record<string, ResourceSchema> = {}
  const fkByConstraint = new Map<
    string,
    { table: string; localColumns: string[]; foreignTable: string; foreignColumns: string[] }
  >()

  for (const { name: tableName } of tables) {
    const cols = rows<ColumnRow>(client, `pragma table_info(${quote(tableName)})`)
    if (cols.length === 0) continue // a view or an unreadable table — nothing to expose

    const pkCols = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name)
    // Prefer a column literally named "id", else the first primary key column.
    const idCol = cols.find((c) => c.name === "id")?.name ?? pkCols[0]

    const fields: Record<string, FieldSchema> = {}
    for (const col of cols) {
      fields[col.name] = {
        name: col.name,
        type: mapSqliteType(col.type),
        // SQLite columns can be declared with no type at all (blob affinity);
        // report that as "BLOB" so nativeType is never an empty string.
        nativeType: col.type || "BLOB",
        // INTEGER PRIMARY KEY is an alias for the implicit rowid, which SQLite
        // fills in when omitted — so it is nullable in neither sense but always
        // has a default. Every other PK column is simply NOT NULL.
        isNullable: col.notnull === 0 && !pkCols.includes(col.name),
        isId: col.name === idCol,
        isPrimaryKeyPart: pkCols.includes(col.name),
        hasDefaultValue: col.dflt_value !== null || isRowidAlias(col, pkCols),
      }
    }

    resources[tableName] = { name: tableName, tableName, fields, relations: {} }

    for (const fk of rows<FkRow>(client, `pragma foreign_key_list(${quote(tableName)})`)) {
      // Constraint ids are per-table, not global, so key on both.
      const id = `${tableName}.${fk.id}`
      const entry = fkByConstraint.get(id) ?? {
        table: tableName,
        localColumns: [],
        foreignTable: fk.table,
        foreignColumns: [],
      }
      entry.localColumns.push(fk.from)
      // A null `to` means "the parent's primary key"; resolve it once the parent
      // table's columns are known, below.
      entry.foreignColumns.push(fk.to ?? "")
      fkByConstraint.set(id, entry)
    }
  }

  resolveImplicitTargets(resources, fkByConstraint)
  addRelations(resources, fkByConstraint)
  return { resources }
}

// `INTEGER PRIMARY KEY` (single-column, integer affinity) aliases SQLite's rowid
// and is auto-assigned on insert, so it behaves as though it had a default even
// though PRAGMA reports dflt_value as null.
function isRowidAlias(col: ColumnRow, pkCols: string[]): boolean {
  return pkCols.length === 1 && pkCols[0] === col.name && col.type.toUpperCase() === "INTEGER"
}

// PRAGMA foreign_key_list leaves `to` null when the constraint targets the
// parent's primary key without naming it. Fill those in from the parent's
// introspected columns so relations carry a concrete join key.
function resolveImplicitTargets(
  resources: Record<string, ResourceSchema>,
  fkByConstraint: Map<
    string,
    { table: string; localColumns: string[]; foreignTable: string; foreignColumns: string[] }
  >,
): void {
  for (const fk of fkByConstraint.values()) {
    const target = resources[fk.foreignTable]
    if (!target) continue
    const targetPk = Object.values(target.fields)
      .filter((f) => f.isPrimaryKeyPart)
      .map((f) => f.name)
    fk.foreignColumns = fk.foreignColumns.map((c, i) => c || targetPk[i] || "")
  }
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
    if (!foreignColumn) continue // unresolvable target — drop rather than emit wrong
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

// SQLite columns have type *affinity*, not a type: the declared name is free
// text and the rules below are SQLite's own affinity algorithm (datatype3.html
// §3.1), applied in order. The extra date/json/uuid cases run first because
// affinity would flatten them to TEXT or NUMERIC and lose the semantics valv
// uses to pick operators and serialise results.
function mapSqliteType(declared: string): FieldType {
  const t = declared.toUpperCase()
  if (!t) return "string" // no declared type — blob affinity

  // Semantic types SQLite has no native equivalent for, recognised by the name
  // the schema author used. BOOLEAN and DATETIME are the conventional spellings
  // recommended by SQLite's own docs for storing those values.
  if (t.includes("BOOL")) return "boolean"
  if (t.includes("DATE") || t.includes("TIME")) return "date"
  if (t.includes("JSON")) return "json"
  if (t.includes("UUID") || t.includes("GUID")) return "uuid"

  // SQLite's affinity rules, in the order the spec applies them.
  if (t.includes("INT")) return "number"
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "string"
  if (t.includes("BLOB")) return "string"
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "number"
  return "number" // numeric affinity — the spec's fallback
}
