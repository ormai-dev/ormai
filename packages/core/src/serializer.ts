import { ValidationError } from "./errors"

// Make a query result JSON-safe for an LLM: Decimal → number, Date → ISO string,
// BigInt → string, recursing through arrays and objects. Depth is bounded so a
// pathologically nested row value (e.g. a deep JSON/Array column) surfaces a
// clean error instead of overflowing the stack.
const MAX_DEPTH = 64

export function serializeResult(value: unknown): unknown {
  return serialize(value, 0)
}

function serialize(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new ValidationError("Result value is too deeply nested.")
  if (value === null || value === undefined) return value

  if (Array.isArray(value)) {
    return value.map((v) => serialize(v, depth + 1))
  }

  if (typeof value === "bigint") {
    return value.toString()
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (typeof value === "object") {
    const v = value as Record<string, unknown>
    if (v._bsontype === "ObjectId" && typeof v.toHexString === "function") {
      return (v.toHexString as () => string)()
    }
    if (
      (v._bsontype === "Decimal128" || v._bsontype === "Long") &&
      typeof v.toString === "function"
    ) {
      return (v.toString as () => string)()
    }
    // Duck-type Decimal.js — constructor name is minified in Prisma's build, but
    // the public method names are preserved, so this check stays reliable.
    if (typeof v.toNumber === "function" && typeof v.toFixed === "function") {
      return (value as { toNumber(): number }).toNumber()
    }

    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      out[k] = serialize(val, depth + 1)
    }
    return out
  }

  return value
}
