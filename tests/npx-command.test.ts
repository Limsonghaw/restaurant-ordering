import { describe, expect, it } from "vitest";
import { npxInvocation } from "../scripts/npx-command.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("local npx invocation for Windows", () => {
  it("uses npx.cmd with shell:true only on win32; Unix stays execFile without a shell", () => {
    expect(npxInvocation("win32")).toEqual({
      command: "npx.cmd",
      args: ["supabase", "db", "query", "--local"],
      shell: true,
    });
    expect(npxInvocation("linux")).toEqual({
      command: "npx",
      args: ["supabase", "db", "query", "--local"],
      shell: false,
    });
    expect(npxInvocation("darwin")).toEqual({
      command: "npx",
      args: ["supabase", "db", "query", "--local"],
      shell: false,
    });
  });

  it("keeps SQL on stdin and does not put the password into argv", () => {
    const root = join(import.meta.dirname, "../scripts");
    const script = readFileSync(
      join(root, "set-local-customer-api-password.mjs"),
      "utf8",
    );
    const helper = readFileSync(join(root, "npx-command.mjs"), "utf8");
    expect(script).toMatch(/execFileSync\(npx\.command, npx\.args/);
    expect(script).toMatch(/shell: npx\.shell/);
    expect(script).toMatch(/input: `alter role customer_api with password/);
    expect(script).not.toMatch(/npx\.args.*,.*password/);
    expect(helper).toContain('args: ["supabase", "db", "query", "--local"]');
  });
});
