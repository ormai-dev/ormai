// The internal query IR. The model never emits this shape — it writes the
// Prisma-idiomatic grammar in grammar.ts, which parses to the tree below. One
// tree then flows through every stage — validate, inject, emit — with no further
// conversions. Keeping the IR tagged and explicit is what makes policy injection
// and column allowlisting provable; the friendly surface stays at the edge.

export type CmpOp = "=" | "!=" | ">" | "<" | ">=" | "<=" | "like" | "ilike"

// A relation path from the query's root resource to a joined table — e.g.
// ["order", "customer"] reaches `customer` via `order`. Each segment is a
// declared relation name; the path doubles as the joined table's alias. A column
// reference carries this to say which table it belongs to (absent = the root).
// Joins are *derived* from the set of paths referenced across the query, never
// declared separately, so they can't drift from the columns that use them.
export type RelPath = string[]

// A select entry is either a bare column or a function call. `as` names the
// output column (the grammar always sets it — the alias is the select key).
export type ColumnSelect = { col: string; rel?: RelPath; as?: string }
export type FnSelect = { fn: string; args: Expr[]; as?: string }
export type SelectItem = ColumnSelect | FnSelect

export type OrderBy = { col: string; rel?: RelPath; dir: "asc" | "desc" }

// A group key is either a SELECT output alias (bare string) or a column —
// optionally on a joined table via `rel`.
export type GroupByItem = string | { col: string; rel?: RelPath }

// The boolean filter tree. `value` leaves become bound params at emit; `col`
// leaves are allowlist-checked in validate. Comparisons, and/or/not — that's the
// whole expression language, and every richer surface operator (in, contains,
// startsWith…) is desugared into it by the grammar.
export type Expr =
  | { kind: "col"; name: string; rel?: RelPath }
  | { kind: "value"; value: unknown }
  | { kind: "cmp"; op: CmpOp; left: Expr; right: Expr }
  | { kind: "null"; expr: Expr; negated: boolean } // IS NULL / IS NOT NULL
  | { kind: "and"; args: Expr[] }
  | { kind: "or"; args: Expr[] }
  | { kind: "not"; arg: Expr }

export interface Query {
  from: string
  select: SelectItem[]
  where?: Expr
  groupBy?: GroupByItem[]
  orderBy?: OrderBy[]
  limit?: number
  offset?: number
}

// ── Mutations ────────────────────────────────────────────────────────────────
// `from` is the resource (uniform with the query IR). `values`/`set` map column
// → scalar; `where` reuses the Expr tree and is required on update/delete. The
// tenant/row scope is injected on top server-side.

export type Scalar = string | number | boolean | null

export type Insert = { from: string; values: Record<string, Scalar> }
export type Update = { from: string; set: Record<string, Scalar>; where: Expr }
export type Delete = { from: string; where: Expr }

// What reaches the adapter after policy injection: forced values merged in, the
// scope predicate AND-ed into WHERE. Tagged with `op` so the adapter can switch.
export type InjectedMutation =
  | { op: "insert"; from: string; values: Record<string, Scalar> }
  | { op: "update"; from: string; set: Record<string, Scalar>; where: Expr }
  | { op: "delete"; from: string; where: Expr }
