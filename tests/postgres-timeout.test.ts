import { describe, it, expect } from "vitest"
import { PostgresAdapter, type PostgresSql } from "@valv/postgres"
import { ValidationError } from "@valv/core"

// A statement_timeout cancellation (SQLSTATE 57014) must reach the caller as an
// actionable ValidationError — not as a raw driver error that core then redacts to
// a generic message, which reads to a model like a grammar mistake. A stub driver
// lets us assert the translation without waiting out the real 10s timeout.
function throwingSql(err: unknown): PostgresSql {
  const sql: PostgresSql = {
    unsafe() {
      throw err
    },
    async begin(cb) {
      return cb(sql)
    },
  }
  return sql
}

describe("postgres adapter: statement timeout", () => {
  it("translates SQLSTATE 57014 into an actionable ValidationError", async () => {
    const adapter = new PostgresAdapter(
      throwingSql(
        Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
      ),
    )
    await expect(adapter.execute("select 1")).rejects.toBeInstanceOf(ValidationError)
    await expect(adapter.execute("select 1")).rejects.toThrow(/timed out/i)
  })

  it("matches on the message when the driver omits the code", async () => {
    const adapter = new PostgresAdapter(
      throwingSql(new Error("ERROR: canceling statement due to statement timeout")),
    )
    await expect(adapter.execute("select 1")).rejects.toThrow(/timed out/i)
  })

  it("lets an unrelated driver error through untouched", async () => {
    const original = Object.assign(new Error("syntax error at or near"), { code: "42601" })
    const adapter = new PostgresAdapter(throwingSql(original))
    await expect(adapter.execute("select 1")).rejects.toBe(original)
  })
})
