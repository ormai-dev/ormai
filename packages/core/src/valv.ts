import type { SchemaMap } from "./catalog"
import type { PolicyFn, PolicyResult, DefaultContext } from "./policy"
import type { ValvAdapter } from "./adapter"
import type { Query, Insert, Update, Delete } from "./ast"
import type { FnDef } from "./functions"
import {
  parseQuery as parseQueryInput,
  parseInsert as parseInsertInput,
  parseUpdate as parseUpdateInput,
  parseDelete as parseDeleteInput,
} from "./grammar"
import { buildQuerySchema, mutationSchema as buildMutationSchema } from "./tools/query-schema"
import { assertWithinLimits } from "./limits"
import { evaluateRead, evaluateWrite, type WriteOp, type EvaluatedPolicy } from "./evaluate"
import { validateQuery, validateMutation, type ScopedTable } from "./validate"
import { injectPolicy, injectMutation, type PolicyScope } from "./inject"
import { resolveJoins, assertJoinLimits, ROOT_ALIAS } from "./joins"
import type { MutationResult } from "./adapter"
import { serializeResult } from "./serializer"
import { resultSchema as deriveResultSchema, type ResultColumn } from "./result-schema"
import { buildTools, AGENT_INSTRUCTIONS, type ToolToggle } from "./tools"
import { visibleResources, listResources } from "./tools/discovery"
import {
  anthropic,
  openai,
  gemini,
  type NeutralTool,
  type AnthropicTool,
  type OpenAITool,
  type GeminiTool,
} from "./formatters"
import { toAiSdk } from "./formatters/ai-sdk"
import { ValidationError, PolicyViolationError } from "./errors"

// Hardcoded query bounds — surfaced as config only if a real need appears.
const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 100

export interface ValvConfig<TContext = DefaultContext, TResources extends string = string> {
  adapter: ValvAdapter
  defaultPolicy?: "deny-all" | "allow-all"
  /** Warn (false, default) or throw (true) when policy() names an unknown resource. */
  strictPolicyKeys?: boolean
  /** Fallback policy for resources without an explicit policy() call. */
  resolvePolicy?: (resource: TResources, ctx: TContext) => PolicyResult
  /** Called after every run, successful or not. */
  onQuery?: (event: QueryEvent<TContext, TResources>) => void
}

export interface QueryEvent<TContext, TResources extends string = string> {
  toolName: string
  resource: TResources
  operation: string
  ctx: TContext
  durationMs: number
  error?: Error
}

export interface ResourceField {
  name: string
  type: string
  isId: boolean
  isNullable: boolean
  hasDefaultValue: boolean
  sensitive: boolean
}

export interface ResourceRelation {
  name: string
  target: string
  type: "belongsTo" | "hasMany" | "manyToMany"
}

export interface ResourceDescriptor {
  name: string
  fields: ResourceField[]
  relations: ResourceRelation[]
  policyStub: string
  /** True for a view or materialized view — readable, not writable. */
  readOnly: boolean
}

export class Valv<TContext = DefaultContext, TResources extends string = string> {
  private adapter: ValvAdapter
  private defaultPolicy: "deny-all" | "allow-all"
  private policies: Record<string, PolicyFn<TContext>> = {}
  private schemaCache: SchemaMap | null = null
  private strictPolicyKeys: boolean
  private resolvePolicyFn?: (resource: TResources, ctx: TContext) => PolicyResult
  private onQueryFn?: (event: QueryEvent<TContext, TResources>) => void

  constructor(config: ValvConfig<TContext, TResources>) {
    this.adapter = config.adapter
    this.defaultPolicy = config.defaultPolicy ?? "deny-all"
    this.strictPolicyKeys = config.strictPolicyKeys ?? false
    this.resolvePolicyFn = config.resolvePolicy
    this.onQueryFn = config.onQuery
  }

  /** Register an access policy for a resource. Use "*" as a wildcard fallback. */
  policy(resource: TResources | "*", fn: PolicyFn<TContext>): this {
    this.policies[resource] = fn
    return this
  }

  /**
   * Run a query and return its serialized rows. The query is structurally
   * validated, semantically checked against the catalog + policy, policy-
   * injected, emitted to SQL, and executed. This is the single read primitive:
   * the query tool's handler calls it, and replaying a stored query is the same
   * call — so a saved query can never outrank or drift from a fresh one.
   */
  async run(query: unknown, ctx: TContext): Promise<unknown> {
    const start = Date.now()
    const resource = extractResource(query) as TResources
    let error: Error | undefined
    try {
      return await this.runQuery(query, ctx)
    } catch (e) {
      // Surface valv's own (safe, actionable) errors; replace anything else —
      // Zod, RangeError, raw driver errors — with a generic message so internal
      // details never reach the caller. The original is kept for onQuery.
      error = e as Error
      throw toSafeError(error)
    } finally {
      this.onQueryFn?.({
        toolName: "query",
        resource,
        operation: "query",
        ctx,
        durationMs: Date.now() - start,
        error,
      })
    }
  }

  /** Insert a row. Forced fields (e.g. tenant_id) are server-injected. */
  create(input: unknown, ctx: TContext): Promise<MutationResult> {
    return this.runWrite("create", input, ctx)
  }

  /** Update rows. The policy's scope predicate is AND-ed into your WHERE. */
  update(input: unknown, ctx: TContext): Promise<MutationResult> {
    return this.runWrite("update", input, ctx)
  }

  /** Delete rows. The policy's scope predicate is AND-ed into your WHERE. */
  delete(input: unknown, ctx: TContext): Promise<MutationResult> {
    return this.runWrite("delete", input, ctx)
  }

  private async runWrite(op: WriteOp, input: unknown, ctx: TContext): Promise<MutationResult> {
    const start = Date.now()
    const resource = extractResource(input) as TResources
    let error: Error | undefined
    try {
      return await this.executeWrite(op, input, ctx)
    } catch (e) {
      error = e as Error
      throw toSafeError(error)
    } finally {
      this.onQueryFn?.({
        toolName: op,
        resource,
        operation: op,
        ctx,
        durationMs: Date.now() - start,
        error,
      })
    }
  }

  private async executeWrite(op: WriteOp, input: unknown, ctx: TContext): Promise<MutationResult> {
    const mutation =
      op === "create"
        ? this.parseInsert(input)
        : op === "update"
          ? this.parseUpdate(input)
          : this.parseDelete(input)

    const catalog = await this.loadSchema()
    if (!hasOwn(catalog.resources, mutation.from)) {
      throw new ValidationError(`Unknown resource "${mutation.from}".`)
    }
    const mutateFn = this.adapter.mutate
    if (!mutateFn) {
      throw new ValidationError("This database does not support writes.")
    }
    const resource = catalog.resources[mutation.from]
    const policies = this.buildEffectivePolicies(catalog)
    const policy = hasOwn(policies, mutation.from) ? policies[mutation.from] : undefined

    const write = evaluateWrite(policy, ctx, resource, op, this.defaultPolicy)
    if (!write.allowed)
      throw new PolicyViolationError(`${op} access to "${mutation.from}" is denied.`)
    // The read policy governs which columns a WHERE may filter on.
    const read = evaluateRead(policy, ctx, resource, this.defaultPolicy)

    validateMutation(op, mutation, resource, write, read)
    const injected = injectMutation(op, mutation, write)
    return mutateFn.call(this.adapter, injected, catalog)
  }

  /**
   * The output columns + coarse types a query will return, derived from its
   * select list + catalog without executing it. Drives dashboard rendering and
   * detects drift in a stored query. Requires the schema to be loaded (it is,
   * after createValv).
   */
  resultSchema(query: unknown): ResultColumn[] {
    const parsed = this.parseQuery(query)
    return deriveResultSchema(parsed, this.requireSchema(), this.adapter.functions())
  }

  /**
   * This connection's function catalog — the base functions plus the adapter's
   * dialect functions. The same registry that types the query grammar's function
   * arguments.
   */
  get functions(): Record<string, FnDef> {
    return this.adapter.functions()
  }

  /**
   * The JSON Schema for the `query` tool's input, with this connection's function
   * catalog baked into its description. Use it to embed the exact query grammar in
   * your own tool (e.g. a chart tool that takes a `query` field) — it can't drift
   * from what the `query` tool accepts.
   */
  querySchema(): object {
    return buildQuerySchema(this.adapter.functions())
  }

  /** The JSON Schema for a write tool's input (`create` / `update` / `delete`). */
  mutationSchema(op: WriteOp): object {
    return buildMutationSchema(op)
  }

  /**
   * Parse and structurally validate a query in the grammar the model emits,
   * returning the internal query. Throws on a malformed or oversized query — use
   * it to validate a hand-built or stored query before {@link run}. Does not check
   * columns/policy against a catalog; that happens at run time, scoped to `ctx`.
   */
  parseQuery(input: unknown): Query {
    assertWithinLimits(input)
    return parseQueryInput(input, this.adapter.functions())
  }

  /** Parse a `create` payload in the write grammar. See {@link parseQuery}. */
  parseInsert(input: unknown): Insert {
    assertWithinLimits(input)
    return parseInsertInput(input)
  }

  /** Parse an `update` payload in the write grammar. See {@link parseQuery}. */
  parseUpdate(input: unknown): Update {
    assertWithinLimits(input)
    return parseUpdateInput(input)
  }

  /** Parse a `delete` payload in the write grammar. See {@link parseQuery}. */
  parseDelete(input: unknown): Delete {
    assertWithinLimits(input)
    return parseDeleteInput(input)
  }

  /**
   * The real `query` tool as a composable unit: the exact grammar schema and
   * description, bound to `ctx`, with an optional post-run `wrap` to transform the
   * rows (draw a chart, save a widget, return a count). Override `name`/
   * `description` to present it as your own tool. Because it reuses the query
   * tool, its schema can't drift from what the model is told elsewhere.
   */
  queryTool(
    ctx: TContext,
    options?: {
      name?: string
      description?: string
      wrap?: (rows: unknown, input: unknown) => unknown | Promise<unknown>
    },
  ): NeutralTool {
    const base = this.neutralTools(ctx).find((t) => t.name === "query")!
    const wrap = options?.wrap
    return {
      name: options?.name ?? base.name,
      description: options?.description ?? base.description,
      parameters: base.parameters,
      execute: wrap ? async (input) => wrap(await base.execute(input), input) : base.execute,
    }
  }

  /**
   * Tools for the model — `query` plus the discovery tools — formatted per
   * provider and bound to `ctx`. Each format takes an optional
   * `{ list, search, describe }` toggle to drop a discovery tool (`query` always
   * stays). Returned tools are policy-filtered: discovery only surfaces what this
   * caller may read.
   */
  get tools() {
    return {
      neutral: (ctx: TContext, toggle?: ToolToggle): NeutralTool[] =>
        this.neutralTools(ctx, toggle),
      anthropic: (ctx: TContext, toggle?: ToolToggle): AnthropicTool[] =>
        this.neutralTools(ctx, toggle).map(anthropic),
      openai: (ctx: TContext, toggle?: ToolToggle): OpenAITool[] =>
        this.neutralTools(ctx, toggle).map(openai),
      gemini: (ctx: TContext, toggle?: ToolToggle): GeminiTool[] =>
        this.neutralTools(ctx, toggle).map(gemini),
      // Vercel AI SDK tool set (async — imports the optional `ai` peer dep).
      aisdk: (ctx: TContext, toggle?: ToolToggle) => toAiSdk(this.neutralTools(ctx, toggle)),
    }
  }

  /**
   * A ready-to-use system-prompt block for an agent driving these tools:
   * {@link AGENT_INSTRUCTIONS} plus the resources this caller may read (so the
   * model can skip the initial list_resources round-trip). Drop it into your
   * system prompt alongside `tools`.
   */
  async instructions(ctx: TContext): Promise<string> {
    const catalog = await this.loadSchema()
    const policies = this.buildEffectivePolicies(catalog)
    const visible = visibleResources(catalog, policies, this.defaultPolicy, ctx)
    const lines = listResources(visible).map(
      (r) => `- ${r.name}${r.description ? ` — ${r.description}` : ""}`,
    )
    return `${AGENT_INSTRUCTIONS}\n\nResources you can query:\n${lines.join("\n")}`
  }

  /**
   * Handle a model tool call by name, dispatching to `query` or a discovery tool
   * and returning its result. Used to drive a raw provider loop; framework
   * integrations call a tool's `execute` directly instead.
   */
  async runTool(name: string, input: unknown, ctx: TContext): Promise<unknown> {
    const tool = this.neutralTools(ctx).find((t) => t.name === name)
    if (!tool) throw new ValidationError(`Unknown tool "${name}".`)
    return tool.execute(input)
  }

  private neutralTools(ctx: TContext, toggle?: ToolToggle): NeutralTool[] {
    const catalog = this.requireSchema()
    const policies = this.buildEffectivePolicies(catalog)
    const visible = visibleResources(catalog, policies, this.defaultPolicy, ctx)
    return buildTools({
      ctx,
      visible,
      functions: this.adapter.functions(),
      run: (query, c) => this.run(query, c),
      write: this.adapter.mutate
        ? {
            create: (input) => this.create(input, ctx),
            update: (input) => this.update(input, ctx),
            delete: (input) => this.delete(input, ctx),
          }
        : undefined,
      toggle,
    })
  }

  private async runQuery(input: unknown, ctx: TContext): Promise<unknown> {
    const query = this.parseQuery(input)
    const catalog = await this.loadSchema()
    if (!hasOwn(catalog.resources, query.from)) {
      throw new ValidationError(`Unknown resource "${query.from}".`)
    }
    const rootResource = catalog.resources[query.from]

    const policies = this.buildEffectivePolicies(catalog)
    const policyFor = (name: string) => (hasOwn(policies, name) ? policies[name] : undefined)

    // Resolve the joins the query's columns imply, and cap their cost.
    const joins = resolveJoins(query, catalog)
    assertJoinLimits(joins)

    // Policy composition: evaluate the root AND every joined resource. A denied
    // resource — or a relation the parent's policy blocks — refuses the whole
    // query. Each table's row predicate is collected to be injected on its alias.
    const rootEval = evaluateRead(policyFor(query.from), ctx, rootResource, this.defaultPolicy)
    if (!rootEval.allowed)
      throw new PolicyViolationError(`Read access to "${query.from}" is denied.`)

    const tables = new Map<string, ScopedTable>([
      [ROOT_ALIAS, { resource: rootResource, allowedFields: new Set(rootEval.allowedFields) }],
    ])
    const evalByAlias = new Map<string, EvaluatedPolicy>([[ROOT_ALIAS, rootEval]])
    const scopes: PolicyScope[] = [{ rel: [], predicate: rootEval.predicate }]

    for (const node of joins) {
      const parent = evalByAlias.get(node.parentAlias)
      if (parent?.relations?.[node.relation.name] === false) {
        throw new PolicyViolationError(`Relation "${node.relation.name}" is not accessible.`)
      }
      const ev = evaluateRead(policyFor(node.resource.name), ctx, node.resource, this.defaultPolicy)
      if (!ev.allowed)
        throw new PolicyViolationError(`Read access to "${node.resource.name}" is denied.`)
      evalByAlias.set(node.alias, ev)
      tables.set(node.alias, { resource: node.resource, allowedFields: new Set(ev.allowedFields) })
      scopes.push({ rel: node.path, predicate: ev.predicate })
    }

    validateQuery(query, tables, MAX_LIMIT)
    const injected = injectPolicy(query, scopes, DEFAULT_LIMIT, MAX_LIMIT)
    const compiled = this.adapter.compile(injected, catalog)
    const rows = await this.adapter.execute(
      compiled.sql,
      compiled.params.map((p) => p.value),
    )
    return serializeResult(rows)
  }

  /** Introspect the schema once and cache it. */
  async loadSchema(): Promise<SchemaMap> {
    this.schemaCache ??= await this.adapter.introspect()
    return this.schemaCache
  }

  // The loaded schema, for the synchronous paths (resultSchema). createValv
  // primes the cache, so this is populated for factory-built instances.
  private requireSchema(): SchemaMap {
    if (!this.schemaCache) {
      throw new Error(
        "[valv] schema not loaded — build the instance with createValv(), which introspects on construction.",
      )
    }
    return this.schemaCache
  }

  /** Resource names discovered from the schema. */
  async resources(): Promise<TResources[]> {
    const schema = await this.loadSchema()
    return Object.keys(schema.resources) as TResources[]
  }

  /** Schema info + policy stubs for every resource — useful for discovering names. */
  async describe(): Promise<ResourceDescriptor[]> {
    const schema = await this.loadSchema()
    return Object.values(schema.resources).map((r) => ({
      name: r.name,
      fields: Object.values(r.fields).map((f) => ({
        name: f.name,
        type: f.type,
        isId: f.isId,
        isNullable: f.isNullable,
        hasDefaultValue: f.hasDefaultValue ?? false,
        sensitive: f.sensitive ?? false,
      })),
      relations: Object.values(r.relations).map((rel) => ({
        name: rel.name,
        target: rel.targetResource,
        type: rel.type,
      })),
      policyStub: buildPolicyStub(r.name),
      readOnly: r.readOnly ?? false,
    }))
  }

  // Expands the "*" wildcard and resolvePolicy fallback into a concrete
  // per-resource map. Pure given the schema, so callers can validate eagerly.
  private buildEffectivePolicies(schema: SchemaMap): Record<string, PolicyFn<TContext>> {
    const wildcard = this.policies["*"]
    const resolver = this.resolvePolicyFn
    if (!wildcard && !resolver) return this.policies

    const effective: Record<string, PolicyFn<TContext>> = { ...this.policies }
    for (const resourceName of Object.keys(schema.resources)) {
      if (effective[resourceName]) continue
      if (wildcard) {
        effective[resourceName] = wildcard
      } else if (resolver) {
        const captured = resourceName as TResources
        effective[resourceName] = (ctx: TContext) => resolver(captured, ctx)
      }
    }
    delete effective["*"]
    return effective
  }

  private validatePolicyKeys(schema: SchemaMap): void {
    const resourceNames = new Set(Object.keys(schema.resources))
    for (const key of Object.keys(this.policies)) {
      if (key === "*" || resourceNames.has(key)) continue
      const msg = `[valv] policy() named unknown resource "${key}". Known: ${[...resourceNames].join(", ")}. Use await valv.describe() to list them.`
      if (this.strictPolicyKeys) throw new Error(msg)
      console.warn(msg)
    }
  }
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

// The resource a query targets, for the audit event — best-effort, since the
// input isn't validated yet when the event's resource is captured.
function extractResource(input: unknown): string {
  return typeof input === "object" && input !== null && "from" in input
    ? String((input as { from: unknown }).from)
    : "unknown"
}

// valv's own errors are author-written and safe for the caller to act on; any
// other throwable may carry internal details (SQL, paths, schema), so it's
// replaced with a generic message.
function toSafeError(err: Error): Error {
  if (err instanceof ValidationError || err instanceof PolicyViolationError) return err
  return new ValidationError("The query could not be processed.")
}

function buildPolicyStub(resourceName: string): string {
  return [
    `valv.policy("${resourceName}", (ctx) => ({`,
    `  read: true,    // or false, or { field: ctx.value } for a row filter`,
    `  write: false,  // or true, or { field: ctx.value } to force fields`,
    `  delete: false,`,
    `  // fields: { deny: ["sensitive_field"] },`,
    `  // relations: { relName: false },`,
    `}))`,
  ].join("\n")
}
