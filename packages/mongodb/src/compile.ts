import { ObjectId } from "mongodb"
import type { Document } from "mongodb"
import type { Expr, FieldSchema, FnSelect, Query, SchemaMap, SelectItem } from "@valv/core"
import { ValidationError } from "@valv/core"

export interface MongoPlan {
  collection: string
  pipeline: Document[]
}

export function compileMongoQuery(query: Query, catalog: SchemaMap): MongoPlan {
  const resource = Object.prototype.hasOwnProperty.call(catalog.resources, query.from)
    ? catalog.resources[query.from]
    : undefined
  if (!resource) throw new ValidationError(`Unknown resource "${query.from}".`)

  const pipeline: Document[] = []
  if (query.where) {
    pipeline.push({ $match: { $expr: { $eq: [compileExpr(query.where, resource.fields), true] } } })
  }

  const aggregate = query.select.some((item) => "fn" in item)
  if (aggregate) {
    pipeline.push(...compileAggregate(query))
  } else {
    appendSourceSort(pipeline, query)
    appendPagination(pipeline, query)
    pipeline.push({ $project: compileProjection(query.select) })
  }

  return { collection: resource.tableName, pipeline }
}

function compileExpr(expr: Expr, fields: Record<string, FieldSchema>): unknown {
  switch (expr.kind) {
    case "col":
      return fieldRef(expr)
    case "value":
      return expr.value
    case "null": {
      const ref = requireColumn(expr.expr)
      const type = { $type: fieldRef(ref) }
      return expr.negated
        ? { $and: [{ $ne: [type, "missing"] }, { $ne: [type, "null"] }] }
        : { $eq: [type, "null"] }
    }
    case "cmp":
      return compileComparison(expr, fields)
    case "and": {
      const args = expr.args.map((arg) => compileExpr(arg, fields))
      return {
        $cond: [{ $in: [false, args] }, false, { $cond: [{ $in: [null, args] }, null, true] }],
      }
    }
    case "or": {
      const args = expr.args.map((arg) => compileExpr(arg, fields))
      return {
        $cond: [{ $in: [true, args] }, true, { $cond: [{ $in: [null, args] }, null, false] }],
      }
    }
    case "not": {
      const arg = compileExpr(expr.arg, fields)
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

function compileComparison(
  expr: Extract<Expr, { kind: "cmp" }>,
  fields: Record<string, FieldSchema>,
): unknown {
  const left = compileOperand(expr.left, expr.right, fields)
  const right = compileOperand(expr.right, expr.left, fields)
  const columns = [expr.left, expr.right].filter(
    (operand): operand is Extract<Expr, { kind: "col" }> => operand.kind === "col",
  )
  const present = columns.map((column) => {
    const type = { $type: fieldRef(column) }
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
        input: fieldRef(expr.left),
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

function compileOperand(operand: Expr, other: Expr, fields: Record<string, FieldSchema>): unknown {
  if (operand.kind === "col") return fieldRef(operand)
  if (operand.kind === "value") {
    const field = other.kind === "col" ? fields[other.name] : undefined
    return { $literal: coerceValue(operand.value, field) }
  }
  return compileExpr(operand, fields)
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

function requireColumn(expr: Expr): Extract<Expr, { kind: "col" }> {
  if (expr.kind !== "col") throw new ValidationError("A null check needs a column.")
  return expr
}

function fieldRef(column: Extract<Expr, { kind: "col" }>): string {
  return fieldPath(column.rel, column.name)
}

function fieldPath(rel: string[] | undefined, name: string): string {
  if (rel?.length) {
    throw new ValidationError("MongoDB relation queries are not supported yet.")
  }
  return `$${name}`
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

function compileProjection(select: SelectItem[]): Document {
  const projection = emptyDocument()
  if (!select.some((item) => !("fn" in item) && outputName(item) === "_id")) projection._id = 0
  for (const item of select) {
    if ("fn" in item) throw new ValidationError("Aggregate functions require an aggregate query.")
    projection[outputName(item)] = { $ifNull: [fieldPath(item.rel, item.col), null] }
  }
  return projection
}

function compileAggregate(query: Query): Document[] {
  const keys = resolveGroupKeys(query)
  const group = emptyDocument()
  group._id = keys.length ? emptyDocument() : null
  keys.forEach((key, index) => {
    group._id[`k${index}`] = fieldRef(key)
  })

  for (const item of query.select) {
    if (!("fn" in item)) continue
    group[outputName(item)] = compileAccumulator(item)
  }

  const project = emptyDocument()
  project._id = 0
  for (const item of query.select) {
    if ("fn" in item) {
      project[outputName(item)] = `$${outputName(item)}`
      continue
    }
    const index = keys.findIndex((key) => sameColumn(key, item))
    if (index === -1) {
      throw new ValidationError(`Column "${item.col}" must appear in groupBy.`)
    }
    project[outputName(item)] = `$_id.k${index}`
  }
  const pipeline: Document[] = [{ $group: group }]
  appendAggregateSort(pipeline, query, keys)
  appendPagination(pipeline, query)
  pipeline.push({ $project: project })
  return pipeline
}

function compileAccumulator(item: FnSelect): Document {
  switch (item.fn) {
    case "count": {
      const arg = item.args[0]
      if (!arg) return { $sum: 1 }
      const column = requireColumn(arg)
      const type = { $type: fieldRef(column) }
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
      return { [`$${item.fn}`]: fieldRef(column) }
    }
    default:
      throw new ValidationError(`Function "${item.fn}" is not available in MongoDB.`)
  }
}

function resolveGroupKeys(query: Query): Extract<Expr, { kind: "col" }>[] {
  const selected = new Map<string, Extract<SelectItem, { col: string }>>()
  for (const item of query.select) if (!("fn" in item)) selected.set(outputName(item), item)

  return (query.groupBy ?? []).map((key) => {
    if (typeof key !== "string") return { kind: "col", name: key.col, rel: key.rel }
    const selectedColumn = selected.get(key)
    return selectedColumn
      ? { kind: "col", name: selectedColumn.col, rel: selectedColumn.rel }
      : { kind: "col", name: key }
  })
}

function appendSourceSort(pipeline: Document[], query: Query): void {
  if (!query.orderBy?.length) return
  const aliases = new Map<string, Extract<SelectItem, { col: string }>>()
  for (const item of query.select) if (!("fn" in item)) aliases.set(outputName(item), item)
  const sort = emptyDocument()
  for (const order of query.orderBy) {
    if (order.rel?.length)
      throw new ValidationError("MongoDB relation queries are not supported yet.")
    const selected = aliases.get(order.col)
    sort[selected?.col ?? order.col] = order.dir === "asc" ? 1 : -1
  }
  pipeline.push({ $sort: sort })
}

function appendAggregateSort(
  pipeline: Document[],
  query: Query,
  keys: Extract<Expr, { kind: "col" }>[],
): void {
  if (!query.orderBy?.length) return
  const sourceByOutput = new Map<string, Extract<SelectItem, { col: string }>>()
  for (const item of query.select) {
    if (!("fn" in item)) sourceByOutput.set(outputName(item), item)
  }
  const sort = emptyDocument()
  for (const order of query.orderBy) {
    if (order.rel?.length)
      throw new ValidationError("MongoDB relation queries are not supported yet.")
    const selected = sourceByOutput.get(order.col)
    const name = selected?.col ?? order.col
    const index = keys.findIndex((key) => key.name === name && !key.rel?.length)
    sort[index >= 0 ? `_id.k${index}` : order.col] = order.dir === "asc" ? 1 : -1
  }
  pipeline.push({ $sort: sort })
}

function appendPagination(pipeline: Document[], query: Query): void {
  if (query.offset !== undefined) pipeline.push({ $skip: query.offset })
  if (query.limit !== undefined) pipeline.push({ $limit: query.limit })
}

function outputName(item: SelectItem): string {
  if ("fn" in item) return item.as ?? item.fn
  return item.as ?? item.col
}

function sameColumn(
  left: Extract<Expr, { kind: "col" }>,
  right: Extract<SelectItem, { col: string }>,
): boolean {
  return left.name === right.col && (left.rel ?? []).join(".") === (right.rel ?? []).join(".")
}

function emptyDocument(): Document {
  return Object.create(null) as Document
}
