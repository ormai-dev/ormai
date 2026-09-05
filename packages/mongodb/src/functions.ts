import type { FnDef } from "@valv/core"

export const MONGODB_DATE_TRUNC_UNITS = ["minute", "hour", "day", "month", "year"] as const

export const MONGODB_FUNCTIONS: Record<string, FnDef> = {
  dateTrunc: {
    args: [{ kind: "column" }, { kind: "enum", values: MONGODB_DATE_TRUNC_UNITS }],
    returns: "date",
    // MongoDB compilation handles this function directly. FnDef still requires
    // a renderer because the shared grammar uses one function descriptor shape.
    render: () => {
      throw new Error("dateTrunc is compiled by the MongoDB adapter.")
    },
  },
}
