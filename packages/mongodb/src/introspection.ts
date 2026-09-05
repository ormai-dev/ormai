import type { Document } from "mongodb"
import type { FieldSchema, FieldType, RelationSchema, ResourceSchema, SchemaMap } from "@valv/core"
import { ValidationError } from "@valv/core"
import type { MongoCollectionInfo, MongoDatabase } from "./types"

export type MongoRelations = Record<string, Record<string, RelationSchema>>

export interface MongoIntrospectionOptions {
  sampleSize?: number
  statementTimeoutMs?: number
  relations?: MongoRelations
}

const DEFAULT_SAMPLE_SIZE = 100
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000
const MAX_NESTING_DEPTH = 8
const MAX_FIELDS_PER_COLLECTION = 1_000
const IDENTIFIER = /^[A-Za-z0-9_]+$/

export async function introspectMongo(
  database: MongoDatabase,
  options: MongoIntrospectionOptions = {},
): Promise<SchemaMap> {
  const collections = await database.listCollections({}, { nameOnly: false }).toArray()
  const resources = Object.create(null) as Record<string, ResourceSchema>

  await Promise.all(
    collections.map(async (collection) => {
      if (collection.name.startsWith("system.")) return
      const samples = await database
        .collection(collection.name)
        .aggregate([{ $sample: { size: options.sampleSize ?? DEFAULT_SAMPLE_SIZE } }], {
          maxTimeMS: options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
          allowDiskUse: false,
        })
        .toArray()

      resources[collection.name] = {
        name: collection.name,
        tableName: collection.name,
        fields: inferFields(collection, samples),
        relations: Object.create(null) as Record<string, RelationSchema>,
        ...(collection.type === "view" ? { readOnly: true } : {}),
      }
    }),
  )

  mergeRelations(resources, options.relations)
  return { resources }
}

interface ObservedField {
  path: string[]
  types: Set<string>
}

function inferFields(
  collection: MongoCollectionInfo,
  samples: Document[],
): Record<string, FieldSchema> {
  const validator = collection.options?.validator?.$jsonSchema as Document | undefined
  const observed = new Map<string, ObservedField>()
  const requiredPaths = new Set<string>()

  const rootRequired = new Set<string>(Array.isArray(validator?.required) ? validator.required : [])
  for (const [name, definition] of Object.entries((validator?.properties as Document) ?? {})) {
    if (!isDocument(definition)) continue
    observeDefinition(observed, requiredPaths, [name], definition, rootRequired.has(name))
  }

  for (const sample of samples) {
    for (const [name, value] of Object.entries(sample)) {
      observeValue(observed, [name], value)
    }
  }

  if (!observed.has("_id")) {
    observed.set("_id", { path: ["_id"], types: new Set(["objectId"]) })
  }

  const fields = Object.create(null) as Record<string, FieldSchema>
  const paths = [...observed.values()].sort((a, b) => a.path.length - b.path.length)
  for (const entry of paths) {
    if (hasDescendant(entry.path, paths)) continue
    const name = entry.path.join("__")
    if (!IDENTIFIER.test(name)) continue
    // A physical top-level field wins when its name collides with a generated
    // nested-field name. The nested path remains inaccessible instead of
    // letting one policy name refer to two BSON values.
    if (Object.prototype.hasOwnProperty.call(fields, name)) continue
    const nonNull = [...entry.types].filter((type) => type !== "null")
    fields[name] = {
      name,
      type: fieldType(nonNull),
      nativeType: collapseNativeType(nonNull),
      isNullable:
        name === "_id"
          ? false
          : entry.types.has("null") ||
            !requiredPaths.has(pathKey(entry.path)) ||
            samples.some((sample) => !hasPath(sample, entry.path)),
      isId: name === "_id",
      isPrimaryKeyPart: name === "_id",
      hasDefaultValue: name === "_id",
      ...(entry.path.length > 1
        ? { jsonPath: { column: entry.path[0], path: entry.path.slice(1) } }
        : {}),
    }
  }
  return fields
}

function observeDefinition(
  observed: Map<string, ObservedField>,
  requiredPaths: Set<string>,
  path: string[],
  definition: Document,
  required: boolean,
): void {
  const types = schemaTypes(definition)
  const properties = isDocument(definition.properties) ? definition.properties : undefined
  const objectOnly = types.filter((type) => type !== "null").every((type) => type === "object")

  if (properties && Object.keys(properties).length > 0 && objectOnly) {
    const nestedRequired = new Set<string>(
      Array.isArray(definition.required) ? definition.required : [],
    )
    for (const [name, child] of Object.entries(properties)) {
      if (!isDocument(child)) continue
      observeDefinition(
        observed,
        requiredPaths,
        [...path, name],
        child,
        required && nestedRequired.has(name),
      )
    }
    return
  }

  const entry = fieldAt(observed, path)
  for (const type of types) entry.types.add(type)
  if (required) requiredPaths.add(pathKey(path))
}

function observeValue(observed: Map<string, ObservedField>, path: string[], value: unknown): void {
  if (
    path.length < MAX_NESTING_DEPTH &&
    isEmbeddedDocument(value) &&
    Object.keys(value).length > 0
  ) {
    for (const [name, child] of Object.entries(value)) {
      observeValue(observed, [...path, name], child)
    }
    return
  }
  fieldAt(observed, path).types.add(bsonType(value))
}

function fieldAt(observed: Map<string, ObservedField>, path: string[]): ObservedField {
  const key = pathKey(path)
  const existing = observed.get(key)
  if (existing) return existing
  if (observed.size >= MAX_FIELDS_PER_COLLECTION) {
    throw new ValidationError(
      `MongoDB collection exposes more than ${MAX_FIELDS_PER_COLLECTION} fields; use a hand-defined schema.`,
    )
  }
  const created = { path, types: new Set<string>() }
  observed.set(key, created)
  return created
}

function pathKey(path: string[]): string {
  return path.join("\0")
}

function hasDescendant(path: string[], fields: ObservedField[]): boolean {
  return fields.some(
    (candidate) =>
      candidate.path.length > path.length &&
      path.every((segment, index) => candidate.path[index] === segment),
  )
}

function hasPath(document: Document, path: string[]): boolean {
  let current: unknown = document
  for (const segment of path) {
    if (!isDocument(current) || !Object.prototype.hasOwnProperty.call(current, segment))
      return false
    current = current[segment]
  }
  return true
}

function isEmbeddedDocument(value: unknown): value is Document {
  return isDocument(value) && !(value instanceof Date) && typeof value._bsontype !== "string"
}

function isDocument(value: unknown): value is Document {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mergeRelations(
  resources: Record<string, ResourceSchema>,
  configured: MongoRelations | undefined,
): void {
  if (!configured) return
  for (const [resourceName, relations] of Object.entries(configured)) {
    const resource = resources[resourceName]
    if (!resource) {
      throw new ValidationError(`MongoDB relations reference unknown resource "${resourceName}".`)
    }
    for (const [name, relation] of Object.entries(relations)) {
      if (!IDENTIFIER.test(name)) {
        throw new ValidationError(`MongoDB relation name "${name}" is not a valid identifier.`)
      }
      if (name !== relation.name) {
        throw new ValidationError(`MongoDB relation "${name}" must use the same name in its value.`)
      }
      const target = resources[relation.targetResource]
      if (!target) {
        throw new ValidationError(
          `MongoDB relation "${name}" references unknown resource "${relation.targetResource}".`,
        )
      }
      if (relation.type === "manyToMany") {
        throw new ValidationError(`MongoDB many-to-many relation "${name}" is not supported.`)
      }
      const localKey =
        relation.type === "belongsTo"
          ? relation.foreignKey
          : (relation.targetKey ?? primaryKey(resource))
      const foreignKey =
        relation.type === "belongsTo"
          ? (relation.targetKey ?? primaryKey(target))
          : relation.foreignKey
      if (!hasField(resource, localKey) || !hasField(target, foreignKey)) {
        throw new ValidationError(`MongoDB relation "${name}" references an unknown join field.`)
      }
      resource.relations[name] = relation
    }
  }
}

function hasField(resource: ResourceSchema, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(resource.fields, name)
}

function primaryKey(resource: ResourceSchema): string {
  return Object.values(resource.fields).find((field) => field.isId)?.name ?? "_id"
}

function schemaTypes(definition: Document): string[] {
  const type = definition.bsonType
  if (typeof type === "string") return [type]
  if (Array.isArray(type)) return type.filter((entry): entry is string => typeof entry === "string")
  return ["object"]
}

function bsonType(value: unknown): string {
  if (value === null) return "null"
  if (value instanceof Date) return "date"
  if (Array.isArray(value)) return "array"
  switch (typeof value) {
    case "string":
      return "string"
    case "number":
      return Number.isInteger(value) ? "int" : "double"
    case "bigint":
      return "long"
    case "boolean":
      return "bool"
    case "object": {
      const bson = (value as { _bsontype?: unknown })._bsontype
      return typeof bson === "string" ? bsonTypeName(bson) : "object"
    }
    default:
      return "object"
  }
}

function bsonTypeName(type: string): string {
  const normalized = type.toLowerCase()
  if (normalized === "objectid") return "objectId"
  if (normalized === "decimal128") return "decimal"
  if (normalized === "long") return "long"
  if (normalized === "int32") return "int"
  if (normalized === "double") return "double"
  if (normalized === "binary") return "binData"
  return type
}

function collapseNativeType(types: string[]): string {
  const unique = new Set(types)
  if ([...unique].every((type) => ["int", "long", "double", "decimal"].includes(type))) {
    return unique.size === 1 ? types[0] : "number"
  }
  return unique.size === 1 ? types[0] : "mixed"
}

function fieldType(types: string[]): FieldType {
  if (types.length === 0) return "json"
  if (types.every((type) => ["int", "long", "double", "decimal", "number"].includes(type))) {
    return "number"
  }
  if (types.every((type) => type === "string")) return "string"
  if (types.every((type) => type === "bool")) return "boolean"
  if (types.every((type) => type === "date")) return "date"
  if (types.every((type) => type === "objectId")) return "string"
  return "json"
}
