import { ValidationError } from "./errors"
import { requiredArgs, type ArgSpec, type FnDef } from "./functions"
import type {
  Query,
  Expr,
  SelectItem,
  OrderBy,
  GroupByItem,
  Scalar,
  Insert,
  Update,
  Delete,
  CmpOp,
  RelPath,
} from "./ast"

// ── Input types ──────────────────────────────────────────────────────────────
// The Prisma-shaped input the grammar accepts — for callers hand-building a query
// or typing a `query` field. Intentionally looser than the parser (dynamic field
// and function keys defeat exhaustive typing), but enough for real authoring help.
// The parser is the source of truth; these describe its accepted shape.

export type ScalarInput = string | number | boolean | null

export interface FilterOperators {
  equals?: ScalarInput
  not?: ScalarInput
  gt?: ScalarInput
  gte?: ScalarInput
  lt?: ScalarInput
  lte?: ScalarInput
  in?: ScalarInput[]
  notIn?: ScalarInput[]
  contains?: string
  startsWith?: string
  endsWith?: string
  mode?: "default" | "insensitive"
}

// A field maps to a value (equality), null (IS NULL), or an operator object;
// AND/OR/NOT combine sub-filters. Field keys are dynamic, so the index signature
// carries every possibility.
export interface FilterInput {
  [field: string]: ScalarInput | FilterOperators | FilterInput | FilterInput[] | undefined
  AND?: FilterInput | FilterInput[]
  OR?: FilterInput[]
  NOT?: FilterInput | FilterInput[]
}

// A positional function argument: a column name, a literal, a `{ col }`, or a
// predicate (a filter). A single value or `true` (no args) is the sugar form.
export type FnArgInput =
  | ScalarInput
  | { col: string }
  | FilterInput
  | Array<ScalarInput | { col: string } | FilterInput>

// A select entry: a plain column (`true`), a renamed/joined column (`{ col }`),
// or a function call keyed by the function name.
export type SelectValue = true | { col: string } | Record<string, FnArgInput | true>

export type SelectInput = Record<string, SelectValue>

export type OrderByInput = Record<string, "asc" | "desc"> | Array<Record<string, "asc" | "desc">>

export interface QueryInput {
  from: string
  select: SelectInput
  where?: FilterInput
  groupBy?: string[]
  orderBy?: OrderByInput
  take?: number
  /** Alias for `take`. */
  limit?: number
  /** Rows to skip before the first returned row, for pagination. */
  skip?: number
}

export interface InsertInput {
  from: string
  data: Record<string, ScalarInput>
}

export interface UpdateInput {
  from: string
  data: Record<string, ScalarInput>
  where: FilterInput
}

export interface DeleteInput {
  from: string
  where: FilterInput
}

// The Prisma-idiomatic input grammar: the surface the model actually writes,
// parsed into the internal IR (ast.ts). Everything here is desugaring — a
// familiar Prisma/SQL shape in, the tagged tree out — so the model rides shapes
// it has seen a million times while validate/inject/emit keep operating on the
// same provable IR. Rejections are ValidationErrors phrased so a retry can fix
// the call.

const IDENT = /^[A-Za-z0-9_]+$/
const MAX_SELECT = 32
const MAX_ORDER_BY = 32
const MAX_REL_DEPTH = 8 // structural ceiling; the friendly join limit is in joins.ts

// Prisma reserves the capitalized logical keywords; every other key in a filter
// object is a column path. A column literally named AND/OR/NOT is unreachable —
// documented, not defended.
const AND = "AND"
const OR = "OR"
const NOT = "NOT"

const QUERY_KEYS = new Set(["from", "where", "select", "groupBy", "orderBy", "take", "limit", "skip"])

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isScalar(v: unknown): v is Scalar {
  return v === null || ["string", "number", "boolean"].includes(typeof v)
}

// A dotted path "customer.region" → the joined column { col: "region",
// rel: ["customer"] }; a bare "status" → a root column. Segments are relation
// names then the column; each must be a plain identifier (so a dot is always a
// separator, never part of a name).
function colRef(path: string): { col: string; rel?: RelPath } {
  const parts = path.split(".")
  if (parts.length > MAX_REL_DEPTH + 1 || parts.some((p) => !IDENT.test(p))) {
    throw new ValidationError(`Invalid column reference "${path}".`)
  }
  const name = parts.pop() as string
  return parts.length ? { col: name, rel: parts } : { col: name }
}

function col(ref: { col: string; rel?: RelPath }): Expr {
  return ref.rel ? { kind: "col", name: ref.col, rel: ref.rel } : { kind: "col", name: ref.col }
}

const value = (v: unknown): Expr => ({ kind: "value", value: v })

const CMP_OPS = new Set<string>(["=", "!=", ">", "<", ">=", "<=", "like", "ilike"])

// Structural validation of a raw tagged Expr — used only for developer-authored
// policy predicates (the one place a tagged tree is still an input; the model
// never writes this shape). Returns the typed node or throws.
export function validateExpr(input: unknown): Expr {
  if (!isObject(input) || typeof input.kind !== "string") {
    throw new ValidationError("Expression must be a tagged node.")
  }
  switch (input.kind) {
    case "col": {
      if (typeof input.name !== "string")
        throw new ValidationError("A col node needs a string `name`.")
      if (input.rel !== undefined && !isStringArray(input.rel)) {
        throw new ValidationError("A col node's `rel` must be an array of strings.")
      }
      return input.rel
        ? { kind: "col", name: input.name, rel: input.rel }
        : { kind: "col", name: input.name }
    }
    case "value":
      return { kind: "value", value: input.value }
    case "null":
      if (typeof input.negated !== "boolean")
        throw new ValidationError("A null node needs a boolean `negated`.")
      return { kind: "null", expr: validateExpr(input.expr), negated: input.negated }
    case "cmp":
      if (typeof input.op !== "string" || !CMP_OPS.has(input.op))
        throw new ValidationError("Invalid comparison operator.")
      return {
        kind: "cmp",
        op: input.op as CmpOp,
        left: validateExpr(input.left),
        right: validateExpr(input.right),
      }
    case "and":
    case "or":
      if (!Array.isArray(input.args) || input.args.length === 0)
        throw new ValidationError(`An ${input.kind} node needs args.`)
      return { kind: input.kind, args: input.args.map(validateExpr) }
    case "not":
      return { kind: "not", arg: validateExpr(input.arg) }
    default:
      throw new ValidationError(`Unknown expression kind "${input.kind}".`)
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string")
}

function cmp(op: CmpOp, ref: { col: string; rel?: RelPath }, v: unknown): Expr {
  return { kind: "cmp", op, left: col(ref), right: value(v) }
}

// col IS NULL / col IS NOT NULL — a null is not a comparable value in SQL, so it
// gets its own node rather than a `= NULL` that silently matches nothing.
function nullCheck(ref: { col: string; rel?: RelPath }, negated: boolean): Expr {
  return { kind: "null", expr: col(ref), negated }
}

// ── where: Prisma filter → Expr ──────────────────────────────────────────────

// Top level: an absent or empty `{}` filter means "no constraint" (the policy
// scope still applies). Nested filters must be non-empty.
export function parseFilter(input: unknown): Expr | undefined {
  if (input === undefined || input === null) return undefined
  if (!isObject(input)) throw new ValidationError("`where` must be a filter object.")
  if (Object.keys(input).length === 0) return undefined
  return filterToExpr(input)
}

// A filter object is an implicit AND over its entries: field conditions plus the
// AND/OR/NOT logical keys.
function filterToExpr(input: Record<string, unknown>): Expr {
  const preds: Expr[] = []
  for (const [key, val] of Object.entries(input)) {
    if (key === AND) preds.push(all(parseFilterList(val, key)))
    else if (key === OR) preds.push({ kind: "or", args: parseFilterList(val, key) })
    else if (key === NOT) preds.push({ kind: "not", arg: all(parseFilterList(val, key)) })
    else preds.push(fieldConditionToExpr(colRef(key), val))
  }
  return all(preds)
}

function all(preds: Expr[]): Expr {
  if (preds.length === 0) throw new ValidationError("Empty filter object.")
  return preds.length === 1 ? preds[0] : { kind: "and", args: preds }
}

// AND/OR/NOT take a filter or an array of filters.
function parseFilterList(val: unknown, key: string): Expr[] {
  const list = Array.isArray(val) ? val : [val]
  if (list.length === 0) throw new ValidationError(`"${key}" needs at least one filter.`)
  return list.map((f) => {
    if (!isObject(f) || Object.keys(f).length === 0) {
      throw new ValidationError(`"${key}" entries must be non-empty filter objects.`)
    }
    return filterToExpr(f)
  })
}

// A field's value is either null (IS NULL), a scalar (equality), or an operator
// object.
function fieldConditionToExpr(ref: { col: string; rel?: RelPath }, cond: unknown): Expr {
  if (cond === null) return nullCheck(ref, false)
  if (isScalar(cond)) return cmp("=", ref, cond)
  if (isObject(cond)) return operatorsToExpr(ref, cond)
  throw new ValidationError(
    `Filter on "${ref.col}" must be a value or an operator object like { gte: 100 } — use { in: [...] } for a list.`,
  )
}

const RANGE: Record<string, CmpOp> = { gt: ">", gte: ">=", lt: "<", lte: "<=" }
const OPERATORS = "equals, not, gt, gte, lt, lte, in, notIn, contains, startsWith, endsWith, mode"

function operatorsToExpr(ref: { col: string; rel?: RelPath }, ops: Record<string, unknown>): Expr {
  const insensitive = ops.mode === "insensitive"
  const preds: Expr[] = []
  for (const [op, val] of Object.entries(ops)) {
    if (op === "mode") continue
    preds.push(operatorToExpr(ref, op, val, insensitive))
  }
  if (preds.length === 0) throw new ValidationError(`Empty filter for "${ref.col}".`)
  return all(preds)
}

function operatorToExpr(
  ref: { col: string; rel?: RelPath },
  op: string,
  val: unknown,
  insensitive: boolean,
): Expr {
  if (op in RANGE) {
    if (val === null || !isScalar(val))
      throw new ValidationError(`"${op}" on "${ref.col}" needs a non-null value.`)
    return cmp(RANGE[op], ref, val)
  }
  switch (op) {
    case "equals":
      // { equals: null } / { not: null } are the explicit IS [NOT] NULL forms.
      if (val === null) return nullCheck(ref, false)
      requireScalar(ref, op, val)
      return cmp("=", ref, val)
    case "not":
      if (val === null) return nullCheck(ref, true)
      requireScalar(ref, op, val)
      return cmp("!=", ref, val)
    case "in":
      return anyOf(ref, val, op)
    case "notIn":
      return { kind: "not", arg: anyOf(ref, val, op) }
    case "contains":
      return like(ref, val, (s) => `%${s}%`, insensitive)
    case "startsWith":
      return like(ref, val, (s) => `${s}%`, insensitive)
    case "endsWith":
      return like(ref, val, (s) => `%${s}`, insensitive)
    default:
      throw new ValidationError(
        `Unknown operator "${op}" on "${ref.col}". Use one of: ${OPERATORS}.`,
      )
  }
}

function requireScalar(ref: { col: string }, op: string, val: unknown): asserts val is Scalar {
  if (!isScalar(val)) throw new ValidationError(`"${op}" on "${ref.col}" needs a value.`)
}

// in / notIn desugar to an OR of equalities — no dedicated SQL IN node needed.
function anyOf(ref: { col: string; rel?: RelPath }, val: unknown, op: string): Expr {
  if (!Array.isArray(val) || val.length === 0) {
    throw new ValidationError(`"${op}" on "${ref.col}" needs a non-empty array.`)
  }
  const eqs = val.map((v) => {
    if (!isScalar(v)) throw new ValidationError(`"${op}" on "${ref.col}" takes a list of values.`)
    return cmp("=", ref, v)
  })
  return eqs.length === 1 ? eqs[0] : { kind: "or", args: eqs }
}

// contains/startsWith/endsWith map to LIKE/ILIKE. The user value is a literal
// substring, so its LIKE metacharacters are escaped (backslash is the default
// escape in Postgres, MySQL, and ClickHouse) — the model never writes raw `%`.
function like(
  ref: { col: string; rel?: RelPath },
  val: unknown,
  wrap: (escaped: string) => string,
  insensitive: boolean,
): Expr {
  if (typeof val !== "string")
    throw new ValidationError(`String filter on "${ref.col}" needs a string.`)
  const escaped = val.replace(/[\\%_]/g, (c) => `\\${c}`)
  return {
    kind: "cmp",
    op: insensitive ? "ilike" : "like",
    left: col(ref),
    right: value(wrap(escaped)),
  }
}

// ── select: { alias: true | { col } | { fn: args } } → SelectItem[] ──────────

export function parseSelect(input: unknown, functions: Record<string, FnDef>): SelectItem[] {
  if (!isObject(input)) {
    throw new ValidationError(
      '`select` is an object of output columns, e.g. { revenue: { sum: "total" } }.',
    )
  }
  const aliases = Object.keys(input)
  if (aliases.length === 0) throw new ValidationError("`select` must select at least one column.")
  if (aliases.length > MAX_SELECT)
    throw new ValidationError(`\`select\` has too many columns (max ${MAX_SELECT}).`)
  return aliases.map((alias) => {
    if (!IDENT.test(alias)) throw new ValidationError(`Invalid output name "${alias}".`)
    return parseSelectItem(alias, input[alias], functions)
  })
}

function parseSelectItem(
  alias: string,
  spec: unknown,
  functions: Record<string, FnDef>,
): SelectItem {
  // `true` → the root column named by the key; its output name is the column
  // name, so no explicit alias is needed.
  if (spec === true) return { col: alias }
  if (!isObject(spec)) {
    throw new ValidationError(
      `\`select.${alias}\` must be true (a column), { col: "path" }, or a function like { sum: "amount" }.`,
    )
  }
  const keys = Object.keys(spec)
  if (keys.length !== 1) {
    throw new ValidationError(`\`select.${alias}\` takes exactly one column or function.`)
  }
  const key = keys[0]
  if (key === "col") {
    if (typeof spec.col !== "string")
      throw new ValidationError(`\`select.${alias}.col\` must be a column path.`)
    const ref = colRef(spec.col)
    // Alias only when the output name differs from what emit would name it by
    // default (the column name for a root column, "rel_col" for a joined one).
    if (ref.rel) return { col: ref.col, rel: ref.rel, as: alias }
    return alias === ref.col ? { col: ref.col } : { col: ref.col, as: alias }
  }
  // hasOwn, never functions[key] — a prototype key ("constructor") must not
  // resolve to an inherited member and be treated as a function.
  const def = Object.prototype.hasOwnProperty.call(functions, key) ? functions[key] : undefined
  if (!def) {
    throw new ValidationError(
      `Unknown function "${key}" in \`select.${alias}\`. Use { col: "..." } for a plain column.`,
    )
  }
  return { fn: key, args: parseFnArgs(key, def, spec[key]), as: alias }
}

function parseFnArgs(fn: string, def: FnDef, raw: unknown): Expr[] {
  // true → no args (count → count(*)); a bare value → the single argument; an
  // array → positional arguments.
  const provided = raw === true ? [] : Array.isArray(raw) ? raw : [raw]
  const min = requiredArgs(def)
  const max = def.args.length
  if (provided.length < min || provided.length > max) {
    const want = min === max ? `${min}` : `${min}-${max}`
    throw new ValidationError(`Function "${fn}" expects ${want} argument(s).`)
  }
  return provided.map((arg, i) => argToExpr(fn, def.args[i], arg))
}

// Route a positional argument by its signature: a column becomes a col node, a
// number/enum a value node, a predicate reuses the filter grammar. Knowing the
// signature is what lets the model write args bare — sum: "total",
// toStartOfInterval: ["ts", 1, "hour"] — with no per-argument tagging.
function argToExpr(fn: string, spec: ArgSpec, raw: unknown): Expr {
  switch (spec.kind) {
    case "column":
      if (typeof raw === "string") return col(colRef(raw))
      if (isObject(raw) && typeof raw.col === "string") return col(colRef(raw.col))
      throw new ValidationError(`Function "${fn}" expects a column name for that argument.`)
    case "number":
      if (typeof raw !== "number")
        throw new ValidationError(`Function "${fn}" expects a number for that argument.`)
      return value(raw)
    case "enum":
      if (typeof raw !== "string")
        throw new ValidationError(`Function "${fn}" expects one of: ${spec.values.join(", ")}.`)
      return value(raw)
    case "predicate":
      if (!isObject(raw))
        throw new ValidationError(`Function "${fn}" expects a filter object for that argument.`)
      return filterToExpr(raw)
  }
}

// ── groupBy / orderBy ────────────────────────────────────────────────────────

export function parseGroupBy(input: unknown): GroupByItem[] {
  if (!Array.isArray(input)) {
    throw new ValidationError("`groupBy` is an array of column names or select aliases.")
  }
  return input.map((g) => {
    if (typeof g !== "string") throw new ValidationError("`groupBy` entries are strings.")
    const ref = colRef(g)
    // A bare name stays a string so it can resolve to a SELECT alias (a time
    // bucket) or a column; a dotted path is unambiguously a joined column.
    return ref.rel ? ref : g
  })
}

export function parseOrderBy(input: unknown): OrderBy[] {
  const entries = Array.isArray(input) ? input : [input]
  const out: OrderBy[] = []
  for (const entry of entries) {
    if (!isObject(entry))
      throw new ValidationError('`orderBy` entries are { column: "asc" | "desc" }.')
    for (const [path, dir] of Object.entries(entry)) {
      if (dir !== "asc" && dir !== "desc") {
        throw new ValidationError(`Sort direction for "${path}" must be "asc" or "desc".`)
      }
      out.push({ ...colRef(path), dir })
    }
  }
  if (out.length > MAX_ORDER_BY)
    throw new ValidationError(`\`orderBy\` has too many keys (max ${MAX_ORDER_BY}).`)
  return out
}

// ── top level ────────────────────────────────────────────────────────────────

export function parseQuery(input: unknown, functions: Record<string, FnDef>): Query {
  if (!isObject(input)) throw new ValidationError("A query must be an object.")
  const unknownKey = Object.keys(input).find((k) => !QUERY_KEYS.has(k))
  if (unknownKey) {
    throw new ValidationError(
      `Unknown query key "${unknownKey}". Use from, select, where, groupBy, orderBy, take, skip.`,
    )
  }
  const query: Query = {
    from: requireResource(input.from),
    select: parseSelect(input.select, functions),
  }
  const where = parseFilter(input.where)
  if (where) query.where = where
  if (input.groupBy !== undefined) query.groupBy = parseGroupBy(input.groupBy)
  if (input.orderBy !== undefined) query.orderBy = parseOrderBy(input.orderBy)
  const take = input.take ?? input.limit
  if (take !== undefined) {
    if (typeof take !== "number" || !Number.isInteger(take) || take <= 0) {
      throw new ValidationError("`take` must be a positive integer.")
    }
    query.limit = take
  }
  if (input.skip !== undefined) {
    if (typeof input.skip !== "number" || !Number.isInteger(input.skip) || input.skip < 0) {
      throw new ValidationError("`skip` must be a non-negative integer.")
    }
    if (input.skip > 0) query.offset = input.skip
  }
  return query
}

// ── writes ───────────────────────────────────────────────────────────────────

export function parseInsert(input: unknown): Insert {
  if (!isObject(input)) throw new ValidationError("A create must be an object.")
  return { from: requireResource(input.from), values: parseData(input.data) }
}

export function parseUpdate(input: unknown): Update {
  if (!isObject(input)) throw new ValidationError("An update must be an object.")
  const where = parseFilter(input.where)
  if (!where)
    throw new ValidationError("`update` requires a `where` filter (no implicit all-rows).")
  return { from: requireResource(input.from), set: parseData(input.data), where }
}

export function parseDelete(input: unknown): Delete {
  if (!isObject(input)) throw new ValidationError("A delete must be an object.")
  const where = parseFilter(input.where)
  if (!where)
    throw new ValidationError("`delete` requires a `where` filter (no implicit all-rows).")
  return { from: requireResource(input.from), where }
}

function requireResource(from: unknown): string {
  if (typeof from !== "string" || from.length === 0) {
    throw new ValidationError("`from` (the resource name) is required.")
  }
  return from
}

function parseData(raw: unknown): Record<string, Scalar> {
  if (!isObject(raw)) throw new ValidationError("`data` is an object of column values.")
  const out: Record<string, Scalar> = {}
  for (const [key, val] of Object.entries(raw)) {
    if (!IDENT.test(key)) throw new ValidationError(`Invalid column name "${key}".`)
    if (!isScalar(val))
      throw new ValidationError(`Column "${key}" must be a string, number, boolean, or null.`)
    out[key] = val
  }
  if (Object.keys(out).length === 0)
    throw new ValidationError("`data` must set at least one column.")
  return out
}
