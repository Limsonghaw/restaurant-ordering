import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { mapPgError, result } from "../lib/data/supabase/pg-errors";

describe("PR2 database error allowlist", () => {
  it.each([
    "CATEGORY_NOT_EMPTY",
    "TABLE_HAS_OPEN_BILL",
    "STORE_SUSPENDED",
    "NOT_FOUND",
    "ORDER_BILL_CLOSED",
  ])("maps %s without private details", (code) => {
    const e = mapPgError({
      code: "P0001",
      message: code,
      details: "private data",
    });
    expect(e.code).toBe(code);
    expect(e.message).not.toContain(code);
    expect(e.details).toEqual({});
  });
  it.each([
    [
      {
        code: "23505",
        message:
          'duplicate key violates unique constraint "dining_tables_store_label_uq"',
      },
      "TABLE_LABEL_TAKEN",
    ],
    [
      { code: "23505", constraint: "dining_tables_store_label_uq" },
      "TABLE_LABEL_TAKEN",
    ],
    [{ code: "23505", message: "secret" }, "CONFLICT"],
    [{ code: "23514", message: "secret" }, "VALIDATION_FAILED"],
    [{ code: "42501", message: "secret" }, "FORBIDDEN"],
    [{ code: "P0001", message: "secret STORE_SUSPENDED" }, "INTERNAL"],
    [{ code: "57014", message: "secret" }, "INTERNAL"],
    [{ message: "secret" }, "INTERNAL"],
  ])("maps database failures safely", (input, code) => {
    const e = mapPgError(input);
    expect(e.code).toBe(code);
    expect(e.message).not.toContain("secret");
    expect(e.details).toEqual({});
  });
  it("sanitizes rejected network promises", async () => {
    await expect(
      result(Promise.reject(new Error("private endpoint"))),
    ).rejects.toMatchObject({
      code: "INTERNAL",
      message: "操作失败，请稍后重试",
    });
  });
  it("keeps the six shared types unique", () => {
    const source = readFileSync("lib/data/types.ts", "utf8");
    for (const type of [
      "StoreStatus",
      "MyStoreSummary",
      "MyContext",
      "BlockedClientRow",
      "BillGoneReason",
      "QuoteEstimate",
    ])
      expect(
        source.match(new RegExp(`export (?:interface|type) ${type}\\b`, "g")),
      ).toHaveLength(1);
  });
  it("uses explicit columns and the approved browser client", () => {
    for (const file of readdirSync("lib/data/supabase").filter((f) =>
      f.endsWith(".ts"),
    )) {
      const source = readFileSync(`lib/data/supabase/${file}`, "utf8");
      expect(source).not.toMatch(/stores\(\s*\*\s*\)/);
      expect(source).not.toMatch(/\.select\(\s*['"]\*['"]/);
      expect(source).not.toMatch(/from ["']@supabase\//);
    }
  });
});
