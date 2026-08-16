import type { Query, Expr, SelectItem, FnSelect, Insert, Update, Delete } from "./ast"
import type { SchemaMap, ResourceSchema } from "./catalog"
import type { CompiledQuery, BoundParam } from "./adapter"
import type { Dialect } from "./dialect"
import { ValidationError } from "./errors"
import { BASE_FUNCTIONS, lookupFunction, requiredArgs, type ArgSpec, type FnDef } from "./functions"
import { resolveJoins, aliasForPath, ROOT_ALIAS, type JoinNode } from "./joins"

// Turns a validated Query into dialect SQL + bound params. Two kinds of check
// live here, both needing the dialect's function registry (which validate.ts,
// running before compile, doesn't have): function-signature checks (arity, arg
// kinds, numeric ranges, enum membership). Policy/column checks already happened
// in validate.ts. Anything that reaches SQL as a literal does so only after one
// of those checks, never by string interpolation of attacker input.

// What emit reads off a field: its native type (for param typing) and, when the
// field is JSON-extracted rather than physical, where to extract it from. The
// full FieldSchema is what's passed in at runtime; this is the slice we use.
type FieldMeta = { nativeType: string; jsonPath?: { column: string; path: string[] } }

// One table in scope at emit time: its columns (for param typing) and the
// quoted, db-qualified name to put in FROM/JOIN.
interface TableScope {
  fields: Record<string, FieldMeta>
  ref: string
}

interface EmitContext {
  fields: Record<string, FieldMeta>
  dialect: Dialect
  params: BoundParam[]
  // Present only when the query joins. When set, columns emit alias-qualified
  // (`"alias"."col"`); when absent, single-table bare columns (`"col"`).
  tables?: Map<string, TableScope>
}

export function emit(
  query: Query,
  catalog: SchemaMap,
  dialect: Dialect,
  options: { database?: string } = {},
): CompiledQuery {
  const resource = catalog.resources[query.from]
  if (!resource) throw new Error(`[valv] unknown resource "${query.from}"`)

  const q = (id: string) => dialect.quoteId(id)
  const refOf = (r: ResourceSchema) =>
    options.database ? `${q(options.database)}.${q(r.tableName)}` : q(r.tableName)
  // Null-prototype merge so an attacker-supplied fn name like "constructor" or
  // "toString" resolves to nothing rather than an inherited Object.prototype
  // member — only own entries exist, keeping the allowlist intact.
  const functions: Record<string, FnDef> = Object.assign(
    Object.create(null),
    BASE_FUNCTIONS,
    dialect.functions,
  )

  const joins = resolveJoins(query, catalog)
  const ctx: EmitContext = { fields: resource.fields, dialect, params: [] }

  // FROM clause. Single-table queries stay bare (FROM "t") for unchanged SQL;
  // joined queries alias every table and qualify every column.
  let from: string
  if (joins.length === 0) {
    from = refOf(resource)
  } else {
    const tables = new Map<string, TableScope>([
      [ROOT_ALIAS, { fields: resource.fields, ref: refOf(resource) }],
    ])
    const resourceByAlias = new Map<string, ResourceSchema>([[ROOT_ALIAS, resource]])
    for (const node of joins) {
      tables.set(node.alias, { fields: node.resource.fields, ref: refOf(node.resource) })
      resourceByAlias.set(node.alias, node.resource)
    }
    ctx.tables = tables
    from =
      `${refOf(resource)} AS ${q(ROOT_ALIAS)} ` +
      joins
        .map((n) => {
          const parent = resourceByAlias.get(n.parentAlias)!
          return `INNER JOIN ${refOf(n.resource)} AS ${q(n.alias)} ON ${joinCondition(n, parent, q)}`
        })
        .join(" ")
  }

  const aliases = new Set<string>()
  for (const item of query.select) if (item.as) aliases.add(item.as)

  const select = query.select.map((item) => emitSelectItem(item, ctx, functions)).join(", ")

  let sql = `SELECT ${select} FROM ${from}`
  if (query.where) sql += ` WHERE ${emitExpr(query.where, ctx)}`
  if (query.groupBy?.length) {
    sql += ` GROUP BY ${query.groupBy.map((g) => emitGroupKey(g, ctx, aliases)).join(", ")}`
  }
  if (query.orderBy?.length) {
    sql += ` ORDER BY ${query.orderBy
      .map(
        (o) =>
          `${emitGroupKey(o.rel ? { col: o.col, rel: o.rel } : o.col, ctx, aliases)} ${o.dir.toUpperCase()}`,
      )
      .join(", ")}`
  }
  if (query.limit !== undefined) sql += ` LIMIT ${Math.trunc(query.limit)}`
  if (query.offset !== undefined) sql += ` OFFSET ${Math.trunc(query.offset)}`

  return { sql, params: ctx.params }
}

// The ON predicate for a join, oriented by which side owns the FK column. The FK
// is schema-derived (never model-supplied), so the condition can't be widened.
function joinCondition(node: JoinNode, parent: ResourceSchema, q: (id: string) => string): string {
  const child = node.resource
  const fk = node.relation.foreignKey
  const fkOnParent = Object.prototype.hasOwnProperty.call(parent.fields, fk)
  if (fkOnParent) {
    // belongsTo (FK local): parent.fk = child.<referenced key>
    const key = node.relation.targetKey ?? primaryKey(child)
    return `${q(node.parentAlias)}.${q(fk)} = ${q(node.alias)}.${q(key)}`
  }
  // hasMany / 1:1-inverse (FK on the child): parent.<referenced key> = child.fk
  const key = node.relation.targetKey ?? primaryKey(parent)
  return `${q(node.parentAlias)}.${q(key)} = ${q(node.alias)}.${q(fk)}`
}

function primaryKey(resource: ResourceSchema): string {
  const id = Object.values(resource.fields).find((f) => f.isId)
  return id?.name ?? "id"
}

// A GROUP BY / ORDER BY key: a bare SELECT alias stays unqualified; a column —
// root or joined — is emitted qualified in join mode.
function emitGroupKey(
  key: string | { col: string; rel?: string[] },
  ctx: EmitContext,
  aliases: Set<string>,
): string {
  if (typeof key === "string") {
    return aliases.has(key) ? ctx.dialect.quoteId(key) : colRef(ctx, undefined, key)
  }
  return colRef(ctx, key.rel, key.col)
}

// Qualify a column to its table's alias when joining; bare otherwise. A
// JSON-extracted field renders through the dialect from its source column instead
// of its own name (which is logical, not a real column).
function colRef(ctx: EmitContext, rel: string[] | undefined, name: string): string {
  const q = (id: string) => ctx.dialect.quoteId(id)
  const alias = ctx.tables ? q(rel?.length ? aliasForPath(rel) : ROOT_ALIAS) : undefined
  const field = fieldsFor(ctx, rel)[name]
  if (field?.jsonPath) {
    if (!ctx.dialect.jsonExtract) {
      throw new Error(`[valv] dialect cannot extract JSON path for field "${name}"`)
    }
    const col = field.jsonPath.column
    const columnRef = alias ? `${alias}.${q(col)}` : q(col)
    return ctx.dialect.jsonExtract(columnRef, field.jsonPath.path, field.nativeType)
  }
  return alias ? `${alias}.${q(name)}` : q(name)
}

// The fields of the table a column belongs to — for typing bound params.
function fieldsFor(ctx: EmitContext, rel: string[] | undefined): Record<string, FieldMeta> {
  if (!ctx.tables) return ctx.fields
  return ctx.tables.get(rel?.length ? aliasForPath(rel) : ROOT_ALIAS)?.fields ?? ctx.fields
}

// ── Mutations ───────────────────────────────────────────────────────────────
// Emit INSERT / UPDATE / DELETE for an already-validated, policy-injected
// mutation. Values bind through the same `bind` as reads — never inlined — and
// the WHERE goes through the shared `emitExpr`.

export function emitInsert(insert: Insert, catalog: SchemaMap, dialect: Dialect): CompiledQuery {
  const ctx = mutationContext(insert.from, catalog, dialect)
  const q = (id: string) => dialect.quoteId(id)
  const cols = Object.keys(insert.values)
  const values = cols.map((c) => bind(ctx, insert.values[c], typeOf(ctx, c)))
  const sql = `INSERT INTO ${q(ctx.tableName)} (${cols.map(q).join(", ")}) VALUES (${values.join(", ")})`
  return { sql, params: ctx.params }
}

export function emitUpdate(update: Update, catalog: SchemaMap, dialect: Dialect): CompiledQuery {
  const ctx = mutationContext(update.from, catalog, dialect)
  const q = (id: string) => dialect.quoteId(id)
  // SET params bind before WHERE params — matching their placeholder order.
  const sets = Object.keys(update.set).map(
    (c) => `${q(c)} = ${bind(ctx, update.set[c], typeOf(ctx, c))}`,
  )
  const sql = `UPDATE ${q(ctx.tableName)} SET ${sets.join(", ")} WHERE ${emitExpr(update.where, ctx)}`
  return { sql, params: ctx.params }
}

export function emitDelete(del: Delete, catalog: SchemaMap, dialect: Dialect): CompiledQuery {
  const ctx = mutationContext(del.from, catalog, dialect)
  const q = (id: string) => dialect.quoteId(id)
  const sql = `DELETE FROM ${q(ctx.tableName)} WHERE ${emitExpr(del.where, ctx)}`
  return { sql, params: ctx.params }
}

function mutationContext(
  from: string,
  catalog: SchemaMap,
  dialect: Dialect,
): EmitContext & { tableName: string } {
  const resource = catalog.resources[from]
  if (!resource) throw new Error(`[valv] unknown resource "${from}"`)
  return { fields: resource.fields, dialect, params: [], tableName: resource.tableName }
}

function typeOf(ctx: EmitContext, col: string): string {
  return Object.prototype.hasOwnProperty.call(ctx.fields, col)
    ? ctx.fields[col].nativeType
    : "String"
}

// ── Select items & function calls ───────────────────────────────────────────

function emitSelectItem(
  item: SelectItem,
  ctx: EmitContext,
  functions: Record<string, FnDef>,
): string {
  const q = (id: string) => ctx.dialect.quoteId(id)
  if ("fn" in item) {
    const expr = emitFunction(item, ctx, functions)
    return item.as ? `${expr} AS ${q(item.as)}` : expr
  }
  const expr = colRef(ctx, item.rel, item.col)
  // A joined column with no explicit alias gets a deterministic one
  // ("customer_name") so result keys stay unique across tables and stable. A
  // JSON-extracted field aliases to its logical name, else the key is raw SQL.
  const jsonField = fieldsFor(ctx, item.rel)[item.col]?.jsonPath !== undefined
  const alias =
    item.as ??
    (item.rel?.length ? `${item.rel.join("_")}_${item.col}` : jsonField ? item.col : undefined)
  return alias ? `${expr} AS ${q(alias)}` : expr
}

function emitFunction(item: FnSelect, ctx: EmitContext, functions: Record<string, FnDef>): string {
  const def = lookupFunction(functions, item.fn)
  const min = requiredArgs(def)
  const max = def.args.length
  if (item.args.length < min || item.args.length > max) {
    const want = min === max ? `${min}` : `${min}-${max}`
    throw new ValidationError(`Function "${item.fn}" expects ${want} argument(s).`)
  }
  // Render each positional arg per its spec; an omitted trailing optional column
  // (e.g. count → count(*)) maps to undefined.
  const parts = def.args.map((spec, i) =>
    i < item.args.length ? emitArg(item.fn, spec, item.args[i], ctx) : undefined,
  )
  return def.render(parts)
}

// Validate one function argument against its signature and render it to SQL.
// The kind decides both the check and how it reaches SQL: columns are quoted,
// numbers/enums are inlined after a value check, predicates go through the
// shared expression emitter (so their literals become bound params).
function emitArg(fn: string, spec: ArgSpec, arg: Expr, ctx: EmitContext): string {
  switch (spec.kind) {
    case "column":
      if (arg.kind !== "col")
        throw new ValidationError(`Function "${fn}" expects a column argument.`)
      return colRef(ctx, arg.rel, arg.name)
    case "number":
      // Finite numbers stringify to digits/sign/dot/exponent only, so inlining
      // can't carry SQL; the range rejects nonsense (e.g. a quantile > 1).
      if (arg.kind !== "value" || typeof arg.value !== "number" || !Number.isFinite(arg.value)) {
        throw new ValidationError(`Function "${fn}" expects a numeric argument.`)
      }
      if (spec.range && (arg.value < spec.range[0] || arg.value > spec.range[1])) {
        throw new ValidationError(
          `Function "${fn}" argument must be within [${spec.range[0]}, ${spec.range[1]}].`,
        )
      }
      return String(arg.value)
    case "enum":
      // Membership-checked against a fixed allowlist → the literal is safe inlined.
      if (
        arg.kind !== "value" ||
        typeof arg.value !== "string" ||
        !spec.values.includes(arg.value)
      ) {
        throw new ValidationError(`Function "${fn}" expects one of: ${spec.values.join(", ")}.`)
      }
      return arg.value
    case "predicate":
      return emitExpr(arg, ctx)
  }
}

// ── Expressions ─────────────────────────────────────────────────────────────

function emitExpr(expr: Expr, ctx: EmitContext): string {
  switch (expr.kind) {
    case "col":
      return colRef(ctx, expr.rel, expr.name)
    case "value":
      return bind(ctx, expr.value, "String")
    case "cmp": {
      const like = expr.op === "like" || expr.op === "ilike"
      // A LIKE pattern is always a string, so bind it as String regardless of the
      // column's native type (typed-placeholder dialects need `{pN:String}`).
      const type = like ? "String" : inferType(expr, ctx)
      const op = like ? (expr.op === "ilike" ? (ctx.dialect.ilike ?? "ILIKE") : "LIKE") : expr.op
      return `(${emitOperand(expr.left, ctx, type)} ${op} ${emitOperand(expr.right, ctx, type)})`
    }
    case "null":
      return `(${emitExpr(expr.expr, ctx)} IS ${expr.negated ? "NOT " : ""}NULL)`
    case "and":
      return `(${expr.args.map((a) => emitExpr(a, ctx)).join(" AND ")})`
    case "or":
      return `(${expr.args.map((a) => emitExpr(a, ctx)).join(" OR ")})`
    case "not":
      return `(NOT ${emitExpr(expr.arg, ctx)})`
  }
}

function emitOperand(expr: Expr, ctx: EmitContext, type: string): string {
  if (expr.kind === "col") return colRef(ctx, expr.rel, expr.name)
  if (expr.kind === "value") return bind(ctx, expr.value, type)
  return emitExpr(expr, ctx)
}

// A bound value is typed by the column it's compared against, so typed-placeholder
// dialects (ClickHouse) get the right cast; defaults to String otherwise. The
// column's type is read from ITS table (root or joined).
function inferType(cmp: Extract<Expr, { kind: "cmp" }>, ctx: EmitContext): string {
  const col = cmp.left.kind === "col" ? cmp.left : cmp.right.kind === "col" ? cmp.right : undefined
  if (col) {
    const fields = fieldsFor(ctx, col.rel)
    if (Object.prototype.hasOwnProperty.call(fields, col.name)) return fields[col.name].nativeType
  }
  return "String"
}

// ── Parameter binding ───────────────────────────────────────────────────────

// Append a value to the param list and return its placeholder. Every caller
// value reaches SQL only through here — there is no path that inlines one.
function bind(ctx: EmitContext, value: unknown, type: string): string {
  const i = ctx.params.length
  ctx.params.push({ value, type })
  return ctx.dialect.placeholder(i, type)
}
