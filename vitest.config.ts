import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: {
    alias: {
      "@valv/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@valv/prisma": path.resolve(__dirname, "packages/prisma/src/index.ts"),
      "@valv/clickhouse": path.resolve(__dirname, "packages/clickhouse/src/index.ts"),
      "@valv/postgres": path.resolve(__dirname, "packages/postgres/src/index.ts"),
      "@valv/mysql": path.resolve(__dirname, "packages/mysql/src/index.ts"),
      "@valv/sqlite": path.resolve(__dirname, "packages/sqlite/src/index.ts"),
      "@valv/mongodb": path.resolve(__dirname, "packages/mongodb/src/index.ts"),
    },
  },
})
