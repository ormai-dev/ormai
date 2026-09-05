import type { Query, Expr, Insert, Update, Delete } from "./ast"
import type { ResourceSchema } from "./catalog"
import type { EvaluatedPolicy, EvaluatedWrite, WriteOp } from "./evaluate"
import { PolicyViolationError, ValidationError } from "./errors"
import { ROOT_ALIAS, aliasForPath } from "./joins"

// One table in scope for a query: the resource and the fields this caller may
// read on it. Keyed by alias (the root, or a joined table's relation-path alias)
// so a column's `rel` path resolves to the right allowlist.
export interface ScopedTable {
  resource: ResourceSchema
  allowedFields: Set<string>
}

// Policies may scope on fields hidden from the model, so they cannot go through
// validateQuery's caller-facing allowlist. They still need catalog validation:
// a misspelled scope must fail closed before any backend interprets it.
export function validatePolicyPredicate(
  predicate: Expr | undefined,
  resource: ResourceSchema,
): void {
  if (!predicate) return
  walkColumns(predicate, (rel, name) => {
    if (rel?.length || !hasOwn(resource.fields, name)) {
      throw new PolicyViolationError(`Policy references unknown field "${name}".`)
    }
  })
}

export function validateForcedPolicyValues(
  forced: Record<string, unknown> | undefined,
  resource: ResourceSchema,
): void {
  if (!forced) return
  for (const name of Object.keys(forced)) {
    if (!hasOwn(resource.fields, name)) {
      throw new PolicyViolationError(`Policy references unknown field "${name}".`)
    }
  }
}

// The semantic gate. Structural validity is already guaranteed by the AST
// schema; this rejects anything illegal against the catalog + policy. Every
// column reference, anywhere in the query, must exist and be on the allowlist of
// the table it targets — fail-closed. With joins, each `rel`-qualified column is
// checked against ITS table, so a join can't reach a denied column on either side.
export function validateQuery(
  query: Query,
  tables: Map<string, ScopedTable>,
  maxLimit: number,
): void {
  // One message whether the column is unknown, denied, or on an unresolved table
  // — never reveal which, so an attacker can't enumerate hidden columns/tables.
  const check = (rel: string[] | undefined, name: string) => {
    const table = tables.get(rel?.length ? aliasForPath(rel) : ROOT_ALIAS)
    if (!table || !hasOwn(table.resource.fields, name) || !table.allowedFields.has(name)) {
      throw new ValidationError(`Column "${name}" is not accessible.`)
    }
  }

  // Every column reference — bare selects, function arguments (incl. columns
  // inside a predicate like countIf(salary > 0)), group/order keys, and filter
  // operands — runs through the same allowlist. An aggregate can't reach a
  // denied (or sensitive) column via avg(salary), countIf(...), or ORDER BY.
  for (const item of query.select) {
    if ("fn" in item) {
      item.args.forEach((a) => walkColumns(a, check))
    } else {
      check(item.rel, item.col)
    }
  }
  if (query.where) {
    walkColumns(query.where, check)
    checkEnumExpr(query.where, tables)
  }

  // GROUP BY / ORDER BY may reference a SELECT output alias (a time bucket, an
  // aggregate) as well as a catalog column — every dialect resolves output names
  // there. The aliased expression was already validated as a select item, so an
  // alias reference adds no column exposure. A `rel`-qualified key is always a
  // real column on that joined table, never an alias.
  const aliases = new Set<string>()
  for (const item of query.select) if (item.as) aliases.add(item.as)
  const checkRef = (rel: string[] | undefined, name: string) => {
    if (rel?.length || !aliases.has(name)) check(rel, name)
  }
  query.groupBy?.forEach((g) =>
    typeof g === "string" ? checkRef(undefined, g) : checkRef(g.rel, g.col),
  )
  query.orderBy?.forEach((o) => checkRef(o.rel, o.col))
  if (query.limit !== undefined && query.limit > maxLimit) {
    throw new ValidationError(`limit ${query.limit} exceeds the maximum of ${maxLimit}.`)
  }
}

// The write gate. `set`/`values` columns must be writable; `where` columns must
// be readable (the model can't filter rows by a column it can't see); an insert
// must provide every required column. Mirrors validateQuery, fail-closed.
export function validateMutation(
  op: WriteOp,
  mutation: Insert | Update | Delete,
  resource: ResourceSchema,
  write: EvaluatedWrite,
  read: EvaluatedPolicy,
): void {
  // A view has no single writable table behind it — reject writes up front
  // rather than letting them reach (and be rejected by) the database.
  if (resource.readOnly) {
    throw new ValidationError(`Resource "${resource.name}" is read-only.`)
  }
  const writable = new Set(write.writableFields)
  const readable = new Set(read.allowedFields)

  const checkWritable = (name: string) => {
    if (!hasOwn(resource.fields, name) || !writable.has(name)) {
      throw new ValidationError(`Column "${name}" is not writable.`)
    }
  }
  // Writes are single-table — a `rel`-qualified column in a WHERE is rejected.
  const checkReadable = (rel: string[] | undefined, name: string) => {
    if (rel?.length) throw new ValidationError(`Joins are not supported in writes.`)
    if (!hasOwn(resource.fields, name) || !readable.has(name)) {
      throw new ValidationError(`Column "${name}" is not accessible.`)
    }
  }

  // Writes are single-table, so every column resolves against the root resource.
  const table = new Map<string, ScopedTable>([[ROOT_ALIAS, { resource, allowedFields: readable }]])

  if (op === "create") {
    const insert = mutation as Insert
    for (const col of Object.keys(insert.values)) checkWritable(col)
    requireFields(resource, insert.values, write.forced)
    checkEnumRecord(resource, insert.values)
  } else if (op === "update") {
    const update = mutation as Update
    for (const col of Object.keys(update.set)) checkWritable(col)
    walkColumns(update.where, checkReadable)
    checkEnumRecord(resource, update.set)
    checkEnumExpr(update.where, table)
  } else {
    walkColumns((mutation as Delete).where, checkReadable)
    checkEnumExpr((mutation as Delete).where, table)
  }
}

// Enum columns have a fixed value set. A filter or write that compares one
// against a value outside that set silently matches (or writes) nothing — a
// common LLM mistake (a typo'd or hallucinated enum). We reject it and name the
// valid values, so a retrying model has what it needs to fix the call.
function checkEnumExpr(expr: Expr, tables: Map<string, ScopedTable>): void {
  switch (expr.kind) {
    case "cmp":
      // A like/ilike pattern (e.g. "ship%") is deliberately not an exact enum
      // member — skip the membership check so a valid pattern isn't rejected.
      if (expr.op !== "like" && expr.op !== "ilike") {
        checkEnumCmp(expr.left, expr.right, tables)
        checkEnumCmp(expr.right, expr.left, tables)
      }
      break
    case "and":
    case "or":
      expr.args.forEach((a) => checkEnumExpr(a, tables))
      break
    case "not":
      checkEnumExpr(expr.arg, tables)
      break
  }
}

// One side of a comparison is a column, the other a literal: if the column is an
// enum, the literal must be one of its values.
function checkEnumCmp(col: Expr, val: Expr, tables: Map<string, ScopedTable>): void {
  if (col.kind !== "col" || val.kind !== "value") return
  const table = tables.get(col.rel?.length ? aliasForPath(col.rel) : ROOT_ALIAS)
  const field = table?.resource.fields[col.name]
  if (field?.type === "enum" && field.enumValues)
    assertEnumMember(field.name, val.value, field.enumValues)
}

// Enum check for write payloads (insert values / update set).
function checkEnumRecord(resource: ResourceSchema, values: Record<string, unknown>): void {
  for (const [col, value] of Object.entries(values)) {
    const field = resource.fields[col]
    if (field?.type === "enum" && field.enumValues) assertEnumMember(col, value, field.enumValues)
  }
}

// null passes (it's "unset"/IS NULL, not a bad enum); anything else must be a
// listed member. The error names every valid value.
function assertEnumMember(column: string, value: unknown, allowed: string[]): void {
  if (value === null) return
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ValidationError(
      `Invalid value for "${column}". Allowed values: ${allowed.join(", ")}.`,
    )
  }
}

// Every NOT-NULL column without a default (and not auto-generated or forced by
// policy) must be supplied — caught here with a clear message, not at the DB.
function requireFields(
  resource: ResourceSchema,
  values: Record<string, unknown>,
  forced: Record<string, unknown> | undefined,
): void {
  for (const field of Object.values(resource.fields)) {
    const required = !field.isNullable && !field.hasDefaultValue && !field.isId
    if (!required) continue
    const provided = hasOwn(values, field.name) || (forced ? hasOwn(forced, field.name) : false)
    if (!provided) throw new ValidationError(`Column "${field.name}" is required.`)
  }
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function walkColumns(expr: Expr, visit: (rel: string[] | undefined, name: string) => void): void {
  switch (expr.kind) {
    case "col":
      visit(expr.rel, expr.name)
      break
    case "value":
      break
    case "cmp":
      walkColumns(expr.left, visit)
      walkColumns(expr.right, visit)
      break
    case "null":
      walkColumns(expr.expr, visit)
      break
    case "and":
    case "or":
      expr.args.forEach((a) => walkColumns(a, visit))
      break
    case "not":
      walkColumns(expr.arg, visit)
      break
  }
}
