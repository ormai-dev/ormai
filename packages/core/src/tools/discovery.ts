import type { SchemaMap, ResourceSchema } from "../catalog"
import type { PolicyFn } from "../policy"
import { evaluateRead } from "../evaluate"

// A resource the caller may read, narrowed to the fields it may see. Discovery
// is built only from these — it never reveals a resource or column the policy
// would deny, so "what exists" equals "what this caller can query".
export interface VisibleResource {
  resource: ResourceSchema
  allowedFields: Set<string>
}

export function visibleResources<TContext>(
  catalog: SchemaMap,
  policies: Record<string, PolicyFn<TContext>>,
  defaultPolicy: "deny-all" | "allow-all",
  ctx: TContext,
): VisibleResource[] {
  const out: VisibleResource[] = []
  for (const [name, resource] of Object.entries(catalog.resources)) {
    const policy = Object.prototype.hasOwnProperty.call(policies, name) ? policies[name] : undefined
    let evaluated
    try {
      evaluated = evaluateRead(policy, ctx, resource, defaultPolicy)
    } catch {
      // A policy that can't be evaluated (fails closed) hides the resource.
      continue
    }
    if (!evaluated.allowed) continue
    out.push({ resource, allowedFields: new Set(evaluated.allowedFields) })
  }
  return out
}

export interface ResourceSummary {
  name: string
  description: string
}

export function listResources(visible: VisibleResource[]): ResourceSummary[] {
  return visible.map(({ resource }) => ({
    name: resource.name,
    description: resource.description ?? "",
  }))
}

// Keyword search over resource names, columns, and descriptions, ranked by where
// the term hits (name > description > column). Substring matching — dependency-
// free and enough to surface the right resource out of many.
export function searchResources(term: string, visible: VisibleResource[]): ResourceSummary[] {
  const q = term.trim().toLowerCase()
  if (!q) return listResources(visible)
  return visible
    .map((v) => ({ v, score: score(q, v) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => ({ name: s.v.resource.name, description: s.v.resource.description ?? "" }))
}

function score(q: string, v: VisibleResource): number {
  let total = 0
  if (v.resource.name.toLowerCase().includes(q)) total += 10
  if (v.resource.description?.toLowerCase().includes(q)) total += 3
  for (const field of v.allowedFields) if (field.toLowerCase().includes(q)) total += 2
  return total
}

export interface ResourceDetail {
  name: string
  description?: string
  fields: {
    name: string
    type: string
    nullable: boolean
    description?: string
    enumValues?: string[]
  }[]
  relations: { name: string; target: string; type: string }[]
}

// Full detail for one resource: only its allowed columns, and only relations to
// other visible resources (so a relation can't reveal a hidden table).
export function describeResource(v: VisibleResource, visibleNames: Set<string>): ResourceDetail {
  const { resource, allowedFields } = v
  return {
    name: resource.name,
    description: resource.description,
    fields: Object.values(resource.fields)
      .filter((f) => allowedFields.has(f.name))
      .map((f) => ({
        name: f.name,
        type: f.type,
        nullable: f.isNullable,
        // A catalog author's note about what the column actually means — units,
        // what NULL signifies, which values are worth grouping by. Without this
        // the model sees only a name and a coarse type, which is rarely enough
        // to pick the right column on a schema it has never seen.
        ...(f.description ? { description: f.description } : {}),
        // Enum columns advertise their valid values so the model filters/writes
        // with a real one instead of guessing.
        ...(f.type === "enum" && f.enumValues ? { enumValues: f.enumValues } : {}),
      })),
    relations: Object.values(resource.relations)
      .filter((r) => visibleNames.has(r.targetResource))
      .map((r) => ({ name: r.name, target: r.targetResource, type: r.type })),
  }
}
