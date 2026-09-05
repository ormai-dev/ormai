import type { Document } from "mongodb"
import type { FieldSchema, FieldType, ResourceSchema, SchemaMap } from "@valv/core"
import type { MongoCollectionInfo, MongoDatabase } from "./types"

export interface MongoIntrospectionOptions {
  sampleSize?: number
  statementTimeoutMs?: number
}

const DEFAULT_SAMPLE_SIZE = 100
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000

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
        relations: {},
        ...(collection.type === "view" ? { readOnly: true } : {}),
      }
    }),
  )

  return { resources }
}

function inferFields(
  collection: MongoCollectionInfo,
  samples: Document[],
): Record<string, FieldSchema> {
  const validator = collection.options?.validator?.$jsonSchema as Document | undefined
  const required = new Set<string>(Array.isArray(validator?.required) ? validator.required : [])
  const observed = new Map<string, Set<string>>()

  for (const [name, definition] of Object.entries((validator?.properties as Document) ?? {})) {
    const types = schemaTypes(definition as Document)
    observed.set(name, new Set(types))
  }

  for (const sample of samples) {
    for (const [name, value] of Object.entries(sample)) {
      const types = observed.get(name) ?? new Set<string>()
      types.add(bsonType(value))
      observed.set(name, types)
    }
  }

  if (!observed.has("_id")) observed.set("_id", new Set(["objectId"]))

  const fields = Object.create(null) as Record<string, FieldSchema>
  for (const [name, types] of observed) {
    const nonNull = [...types].filter((type) => type !== "null")
    const nativeType = collapseNativeType(nonNull)
    fields[name] = {
      name,
      type: fieldType(nonNull),
      nativeType,
      isNullable:
        name === "_id"
          ? false
          : types.has("null") || !required.has(name) || samples.some((sample) => !(name in sample)),
      isId: name === "_id",
      isPrimaryKeyPart: name === "_id",
      hasDefaultValue: name === "_id",
    }
  }
  return fields
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
