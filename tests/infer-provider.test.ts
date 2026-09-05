import { describe, it, expect } from "vitest"
import { inferProvider } from "@valv/prisma"
import { configFromEnv, inferProvider as inferMcpProvider } from "../packages/mcp/src/config"

describe("inferProvider", () => {
  it("maps connection schemes to Prisma providers", () => {
    expect(inferProvider("postgres://u:p@h/db")).toBe("postgresql")
    expect(inferProvider("postgresql://u:p@h/db")).toBe("postgresql")
    expect(inferProvider("mysql://u:p@h/db")).toBe("mysql")
    expect(inferProvider("sqlserver://h;database=db")).toBe("sqlserver")
    expect(inferProvider("file:./dev.db")).toBe("sqlite")
    expect(inferProvider("sqlite:./dev.db")).toBe("sqlite")
    expect(inferProvider("mongodb://h/db")).toBe("mongodb")
    expect(inferProvider("mongodb+srv://h/db")).toBe("mongodb")
  })

  it("throws on an unknown scheme", () => {
    expect(() => inferProvider("redis://h")).toThrow()
  })

  it("recognizes native MCP adapters", () => {
    expect(inferMcpProvider("mongodb://h/db")).toBe("mongodb")
    expect(inferMcpProvider("mongodb+srv://h/db")).toBe("mongodb")
    expect(inferMcpProvider("https://clickhouse.example.com")).toBe("clickhouse")
  })

  it("keeps the MongoDB database override in MCP configuration", () => {
    expect(
      configFromEnv(
        {
          DATABASE_URL: "mongodb://localhost:27017",
          VALV_DATABASE: "analytics",
        },
        [],
      ),
    ).toMatchObject({
      provider: "mongodb",
      database: "analytics",
    })
  })
})
