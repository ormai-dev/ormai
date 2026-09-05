import { ObjectId } from "mongodb"
import type { Document } from "mongodb"
import type {
  Expr,
  FieldSchema,
  FnSelect,
  Query,
  ResourceSchema,
  SchemaMap,
  SelectItem,
} from "@valv/core"
import { aliasForPath, resolveJoins, ROOT_ALIAS, ValidationError } from "@valv/core"
import type { JoinNode } from "@valv/core"

export interface MongoPlan {
  collection: string
  pipeline: Document[]
}

interface CompileContext {
  resources: Map<string, ResourceSchema>
}

interface GroupKey {
  expression: unknown
  selectedOutput?: string
  column?: Extract<Expr, { kind: "col" }>
}

const AGGREGATE_FUNCTIONS = new Set(["count", "sum", "avg", "min", "max"])

export function compileMongoQuery(query: Query, catalog: SchemaMap): MongoPlan {
  const resource = ownResource(catalog, query.from)
  const joins = resolveJoins(query, catalog)
  const ctx = compileContext(catalog, resource, joins)
  const pipeline: Document[] = []

  appendLookups(pipeline, resource, joins)
  if (query.where) {
    pipeline.push({ $match: { $expr: { $eq: [compileExpr(query.where, ctx), true] } } })
  }

  const aggregate =
    Boolean(query.groupBy?.length) ||
    query.select.some((item) => "fn" in item && AGGREGATE_FUNCTIONS.has(item.fn))
  if (aggregate) {
    pipeline.push(...compileAggregate(query, ctx))
  } else {
    appendSourceSort(pipeline, query, ctx)
    appendPagination(pipeline, query)
    pipeline.push({ $project: compileProjection(query.select, ctx) })
  }

  return { collection: resource.tableName, pipeline }
}

function ownResource(catalog: SchemaMap, name: string): ResourceSchema {
  const resource = Object.prototype.hasOwnProperty.call(catalog.resources, name)
    ? catalog.resources[name]
    : undefined
  if (!resource) throw new ValidationError(`Unknown resource "${name}".`)
  return resource
}

function compileContext(
  catalog: SchemaMap,
  root: ResourceSchema,
  joins: JoinNode[],
): CompileContext {
  const resources = new Map<string, ResourceSchema>([[ROOT_ALIAS, root]])
  for (const join of joins) resources.set(join.alias, join.resource)
  return { resources }
}

function appendLookups(pipeline: Document[], root: ResourceSchema, joins: JoinNode[]): void {
  const resources = new Map<string, ResourceSchema>([[ROOT_ALIAS, root]])
  for (const node of joins) {
    const parent = resources.get(node.parentAlias)
    if (!parent) throw new ValidationError("Invalid relation path.")
    const child = node.resource
    const foreignKeyOnParent = node.relation.type === "belongsTo"
    const localName = foreignKeyOnParent
      ? node.relation.foreignKey
      : (node.relation.targetKey ?? primaryKey(parent))
    const foreignName = foreignKeyOnParent
      ? (node.relation.targetKey ?? primaryKey(child))
      : node.relation.foreignKey

    const localPath = storagePath(parent, localName)
    const foreignPath = storagePath(child, foreignName)
    const parentPrefix = node.parentAlias === ROOT_ALIAS ? "" : `${node.parentAlias}.`
    pipeline.push({
      $lookup: {
        from: child.tableName,
        localField: `${parentPrefix}${localPath}`,
        foreignField: foreignPath,
        as: node.alias,
      },
    })
    pipeline.push({ $unwind: { path: `$${node.alias}` } })
    resources.set(node.alias, child)
  }
}

function compileExpr(expr: Expr, ctx: CompileContext): unknown {
  switch (expr.kind) {
    case "col":
      return fieldRef(expr, ctx)
    case "value":
      return expr.value
    case "null": {
      const ref = requireColumn(expr.expr)
      const type = { $type: fieldRef(ref, ctx) }
      return expr.negated
        ? { $and: [{ $ne: [type, "missing"] }, { $ne: [type, "null"] }] }
        : { $eq: [type, "null"] }
    }
    case "cmp":
      return compileComparison(expr, ctx)
    case "and": {
      const args = expr.args.map((arg) => compileExpr(arg, ctx))
      return {
        $cond: [{ $in: [false, args] }, false, { $cond: [{ $in: [null, args] }, null, true] }],
      }
    }
    case "or": {
      const args = expr.args.map((arg) => compileExpr(arg, ctx))
      return {
        $cond: [{ $in: [true, args] }, true, { $cond: [{ $in: [null, args] }, null, false] }],
      }
    }
    case "not": {
      const arg = compileExpr(expr.arg, ctx)
      return {
        $switch: {
          branches: [
            { case: { $eq: [arg, true] }, then: false },
            { case: { $eq: [arg, false] }, then: true },
          ],
          default: null,
        },
      }
    }
  }
}

function compileComparison(expr: Extract<Expr, { kind: "cmp" }>, ctx: CompileContext): unknown {
  const left = compileOperand(expr.left, expr.right, ctx)
  const right = compileOperand(expr.right, expr.left, ctx)
  const columns = [expr.left, expr.right].filter(
    (operand): operand is Extract<Expr, { kind: "col" }> => operand.kind === "col",
  )
  const present = columns.map((column) => {
    const type = { $type: fieldRef(column, ctx) }
    return { $and: [{ $ne: [type, "missing"] }, { $ne: [type, "null"] }] }
  })

  let comparison: unknown
  if (expr.op === "like" || expr.op === "ilike") {
    if (
      expr.left.kind !== "col" ||
      expr.right.kind !== "value" ||
      typeof expr.right.value !== "string"
    ) {
      throw new ValidationError("A string comparison needs a column and string value.")
    }
    comparison = {
      $regexMatch: {
        input: fieldRef(expr.left, ctx),
        regex: likePatternToRegex(expr.right.value),
        ...(expr.op === "ilike" ? { options: "i" } : {}),
      },
    }
  } else {
    const operator = {
      "=": "$eq",
      "!=": "$ne",
      ">": "$gt",
      "<": "$lt",
      ">=": "$gte",
      "<=": "$lte",
    }[expr.op]
    comparison = { [operator]: [left, right] }
  }

  return { $cond: [{ $and: present }, comparison, null] }
}

function compileOperand(operand: Expr, other: Expr, ctx: CompileContext): unknown {
  if (operand.kind === "col") return fieldRef(operand, ctx)
  if (operand.kind === "value") {
    const field = other.kind === "col" ? fieldFor(other, ctx) : undefined
    return { $literal: coerceValue(operand.value, field) }
  }
  return compileExpr(operand, ctx)
}

function coerceValue(value: unknown, field: FieldSchema | undefined): unknown {
  if (typeof value !== "string" || !field) return value
  if (field.nativeType.toLowerCase() === "objectid") {
    if (!ObjectId.isValid(value)) {
      throw new ValidationError(`Value for "${field.name}" is not a valid ObjectId.`)
    }
    return new ObjectId(value)
  }
  if (field.type === "date") {
    const date = new Date(value)
    if (Number.isNaN(date.valueOf())) {
      throw new ValidationError(`Value for "${field.name}" is not a valid date.`)
    }
    return date
  }
  return value
}

function requireColumn(expr: Expr | undefined): Extract<Expr, { kind: "col" }> {
  if (!expr || expr.kind !== "col") throw new ValidationError("A column argument is required.")
  return expr
}

function fieldRef(column: Extract<Expr, { kind: "col" }>, ctx: CompileContext): string {
  const resource = resourceFor(column.rel, ctx)
  const prefix = column.rel?.length ? `${aliasForPath(column.rel)}.` : ""
  return `$${prefix}${storagePath(resource, column.name)}`
}

function fieldFor(
  column: Extract<Expr, { kind: "col" }>,
  ctx: CompileContext,
): FieldSchema | undefined {
  const resource = resourceFor(column.rel, ctx)
  return hasField(resource, column.name) ? resource.fields[column.name] : undefined
}

function resourceFor(rel: string[] | undefined, ctx: CompileContext): ResourceSchema {
  const resource = ctx.resources.get(rel?.length ? aliasForPath(rel) : ROOT_ALIAS)
  if (!resource) throw new ValidationError("Relation is not accessible.")
  return resource
}

function storagePath(resource: ResourceSchema, name: string): string {
  if (!hasField(resource, name)) {
    throw new ValidationError(`Relation key "${name}" is not accessible.`)
  }
  const field = resource.fields[name]
  return field.jsonPath ? [field.jsonPath.column, ...field.jsonPath.path].join(".") : field.name
}

function hasField(resource: ResourceSchema, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(resource.fields, name)
}

function primaryKey(resource: ResourceSchema): string {
  return Object.values(resource.fields).find((field) => field.isId)?.name ?? "_id"
}

function likePatternToRegex(pattern: string): string {
  let out = "^"
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === "\\" && i + 1 < pattern.length) {
      out += escapeRegex(pattern[++i])
    } else if (char === "%") {
      out += ".*"
    } else if (char === "_") {
      out += "."
    } else {
      out += escapeRegex(char)
    }
  }
  return `${out}$`
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function compileProjection(select: SelectItem[], ctx: CompileContext): Document {
  const projection = emptyDocument()
  if (!select.some((item) => !("fn" in item) && outputName(item) === "_id")) projection._id = 0
  for (const item of select) {
    const value = "fn" in item ? compileScalarFunction(item, ctx) : fieldRef(toColumn(item), ctx)
    projection[outputName(item)] = { $ifNull: [value, null] }
  }
  return projection
}

function compileAggregate(query: Query, ctx: CompileContext): Document[] {
  const keys = resolveGroupKeys(query, ctx)
  const group = emptyDocument()
  group._id = keys.length ? emptyDocument() : null
  keys.forEach((key, index) => {
    group._id[`k${index}`] = key.expression
  })

  for (const item of query.select) {
    if ("fn" in item && AGGREGATE_FUNCTIONS.has(item.fn)) {
      group[outputName(item)] = compileAccumulator(item, ctx)
    }
  }

  const project = emptyDocument()
  project._id = 0
  for (const item of query.select) {
    if ("fn" in item && AGGREGATE_FUNCTIONS.has(item.fn)) {
      project[outputName(item)] = `$${outputName(item)}`
      continue
    }
    const index = groupKeyIndex(keys, item)
    if (index === -1) {
      throw new ValidationError(
        `Column or expression "${outputName(item)}" must appear in groupBy.`,
      )
    }
    project[outputName(item)] = `$_id.k${index}`
  }

  const pipeline: Document[] = [{ $group: group }]
  appendAggregateSort(pipeline, query, keys)
  appendPagination(pipeline, query)
  pipeline.push({ $project: project })
  return pipeline
}

function compileAccumulator(item: FnSelect, ctx: CompileContext): Document {
  switch (item.fn) {
    case "count": {
      const arg = item.args[0]
      if (!arg) return { $sum: 1 }
      const column = requireColumn(arg)
      const type = { $type: fieldRef(column, ctx) }
      return {
        $sum: {
          $cond: [{ $and: [{ $ne: [type, "missing"] }, { $ne: [type, "null"] }] }, 1, 0],
        },
      }
    }
    case "sum":
    case "avg":
    case "min":
    case "max": {
      const column = requireColumn(item.args[0])
      return { [`$${item.fn}`]: fieldRef(column, ctx) }
    }
    default:
      throw new ValidationError(`Function "${item.fn}" is not an aggregate function.`)
  }
}

function compileScalarFunction(item: FnSelect, ctx: CompileContext): unknown {
  if (item.fn !== "dateTrunc") {
    throw new ValidationError(`Function "${item.fn}" is not available in MongoDB.`)
  }
  const column = requireColumn(item.args[0])
  const unit = item.args[1]
  if (!unit || unit.kind !== "value" || typeof unit.value !== "string") {
    throw new ValidationError('Function "dateTrunc" needs a date column and time unit.')
  }
  return { $dateTrunc: { date: fieldRef(column, ctx), unit: unit.value } }
}

function resolveGroupKeys(query: Query, ctx: CompileContext): GroupKey[] {
  const selected = new Map(query.select.map((item) => [outputName(item), item]))
  return (query.groupBy ?? []).map((key) => {
    if (typeof key !== "string") {
      const column = toExprColumn(key)
      return { expression: fieldRef(column, ctx), column }
    }

    const item = selected.get(key)
    if (!item) {
      const column: Extract<Expr, { kind: "col" }> = { kind: "col", name: key }
      return { expression: fieldRef(column, ctx), column }
    }
    if ("fn" in item) {
      if (AGGREGATE_FUNCTIONS.has(item.fn)) {
        throw new ValidationError(`Aggregate "${key}" cannot appear in groupBy.`)
      }
      return { expression: compileScalarFunction(item, ctx), selectedOutput: key }
    }
    const column = toColumn(item)
    return { expression: fieldRef(column, ctx), selectedOutput: key, column }
  })
}

function groupKeyIndex(keys: GroupKey[], item: SelectItem): number {
  const output = outputName(item)
  return keys.findIndex((key) => {
    if (key.selectedOutput === output) return true
    return !("fn" in item) && key.column ? sameColumn(key.column, item) : false
  })
}

function appendSourceSort(pipeline: Document[], query: Query, ctx: CompileContext): void {
  if (!query.orderBy?.length) return
  const selected = new Map(query.select.map((item) => [outputName(item), item]))
  const computed = emptyDocument()
  const sort = emptyDocument()
  for (const [index, order] of query.orderBy.entries()) {
    const item = !order.rel?.length ? selected.get(order.col) : undefined
    if (item && "fn" in item) {
      const temporary = availableTemporaryField(ctx, computed, index)
      computed[temporary] = compileScalarFunction(item, ctx)
      sort[temporary] = order.dir === "asc" ? 1 : -1
      continue
    }
    const column = item && !("fn" in item) ? toColumn(item) : toExprColumn(order)
    sort[fieldRef(column, ctx).slice(1)] = order.dir === "asc" ? 1 : -1
  }
  if (Object.keys(computed).length) pipeline.push({ $set: computed })
  pipeline.push({ $sort: sort })
}

function availableTemporaryField(ctx: CompileContext, computed: Document, index: number): string {
  const root = ctx.resources.get(ROOT_ALIAS)
  let suffix = index
  while (
    (root && hasField(root, `__valv_sort_${suffix}`)) ||
    Object.prototype.hasOwnProperty.call(computed, `__valv_sort_${suffix}`)
  ) {
    suffix++
  }
  return `__valv_sort_${suffix}`
}

function appendAggregateSort(pipeline: Document[], query: Query, keys: GroupKey[]): void {
  if (!query.orderBy?.length) return
  const selected = new Map(query.select.map((item) => [outputName(item), item]))
  const sort = emptyDocument()
  for (const order of query.orderBy) {
    const item = !order.rel?.length ? selected.get(order.col) : undefined
    if (item && "fn" in item && AGGREGATE_FUNCTIONS.has(item.fn)) {
      sort[order.col] = order.dir === "asc" ? 1 : -1
      continue
    }
    const index = item
      ? groupKeyIndex(keys, item)
      : keys.findIndex((key) => key.column && sameColumn(key.column, toExprColumn(order)))
    if (index === -1) {
      throw new ValidationError(`Order expression "${order.col}" must appear in groupBy.`)
    }
    sort[`_id.k${index}`] = order.dir === "asc" ? 1 : -1
  }
  pipeline.push({ $sort: sort })
}

function appendPagination(pipeline: Document[], query: Query): void {
  if (query.offset !== undefined) pipeline.push({ $skip: query.offset })
  if (query.limit !== undefined) pipeline.push({ $limit: query.limit })
}

function outputName(item: SelectItem): string {
  if ("fn" in item) return item.as ?? item.fn
  return item.as ?? (item.rel?.length ? `${item.rel.join("_")}_${item.col}` : item.col)
}

function toColumn(item: Extract<SelectItem, { col: string }>): Extract<Expr, { kind: "col" }> {
  return { kind: "col", name: item.col, ...(item.rel ? { rel: item.rel } : {}) }
}

function toExprColumn(item: { col: string; rel?: string[] }): Extract<Expr, { kind: "col" }> {
  return { kind: "col", name: item.col, ...(item.rel ? { rel: item.rel } : {}) }
}

function sameColumn(
  left: Extract<Expr, { kind: "col" }>,
  right: { col: string; rel?: string[] } | Extract<Expr, { kind: "col" }>,
): boolean {
  const name = "col" in right ? right.col : right.name
  return left.name === name && (left.rel ?? []).join(".") === (right.rel ?? []).join(".")
}

function emptyDocument(): Document {
  return Object.create(null) as Document
}
