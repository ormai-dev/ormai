import type { SchemaMap } from "./catalog"
import type { Query, InjectedMutation } from "./ast"
import type { FnDef } from "./functions"

export interface BoundParam {
  value: unknown
  type: string // dialect type used in the placeholder, e.g. "UInt32"
}

export interface CompiledQuery {
  sql: string
  params: BoundParam[]
}

export interface MutationResult {
  affected: number
}

/**
 * The database seam. Core validates and policy-checks the AST, then hands the
 * resulting query to the adapter. The adapter owns backend-specific compilation
 * and execution. It never sees policy functions or caller context; security
 * logic stays in core and reaches the adapter already injected into the query.
 */
export interface ValvAdapter {
  introspect(): Promise<SchemaMap>
  /** Run a validated, policy-injected query against the backend. */
  run(query: Query, catalog: SchemaMap): Promise<unknown[]>
  /** The functions callable in this dialect (base ∪ dialect), for output-shape
   *  prediction and tool discovery. */
  functions(): Record<string, FnDef>
  /** Run a validated, policy-injected write. Optional — adapters without write
   *  support (or for unsupported ops) throw. */
  mutate?(mutation: InjectedMutation, catalog: SchemaMap): Promise<MutationResult>
}
