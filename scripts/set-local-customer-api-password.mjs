/**
 * Set a local-only password for the customer_api role after `npx supabase start`
 * or `npx supabase db reset --local`. Does not write secrets into the repo,
 * print the connection string, or put the password on the process command line.
 *
 * Optional: CUSTOMER_API_PASSWORD (otherwise a random hex password is generated).
 * Requires .env.local; CUSTOMER_API_DATABASE_URL is updated in that gitignored file.
 */
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { npxInvocation } from "./npx-command.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env.local");
if (!existsSync(envPath)) {
  throw new Error(
    "No .env.local found. Copy .env.example to .env.local, then re-run this script. The password is not printed.",
  );
}
const password =
  process.env.CUSTOMER_API_PASSWORD || randomBytes(32).toString("hex");
if (!/^[A-Za-z0-9]+$/.test(password)) {
  throw new Error(
    "CUSTOMER_API_PASSWORD may only contain letters and digits so it is safe in SQL and URLs",
  );
}
// Pipe SQL on stdin so the password is not visible in the process command line.
// `supabase db query` in CLI 2.122.1 accepts piped stdin when --file and a
// positional SQL argument are omitted.
// Windows: use npx.cmd and shell:true (CVE-2024-27980). Args are constants.
const npx = npxInvocation();
execFileSync(npx.command, npx.args, {
  cwd: root,
  input: `alter role customer_api with password '${password}';\n`,
  stdio: ["pipe", "inherit", "inherit"],
  shell: npx.shell,
});
const url = `postgresql://customer_api:${password}@127.0.0.1:54322/postgres`;
const current = readFileSync(envPath, "utf8");
const next = current.includes("CUSTOMER_API_DATABASE_URL=")
  ? current.replace(
      /^CUSTOMER_API_DATABASE_URL=.*$/m,
      `CUSTOMER_API_DATABASE_URL=${url}`,
    )
  : `${current.replace(/\s*$/, "\n")}CUSTOMER_API_DATABASE_URL=${url}\n`;
writeFileSync(envPath, next);
console.log("Updated CUSTOMER_API_DATABASE_URL in .env.local");
