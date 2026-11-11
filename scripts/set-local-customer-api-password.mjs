/**
 * Set a local-only password for the customer_api role after `npx supabase start`
 * or `npx supabase db reset --local`. Does not write secrets into the repo.
 *
 * Optional: CUSTOMER_API_PASSWORD (otherwise a random hex password is generated).
 * If .env.local exists, CUSTOMER_API_DATABASE_URL is updated in that gitignored file.
 */
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const password =
  process.env.CUSTOMER_API_PASSWORD || randomBytes(32).toString("hex");
if (!/^[A-Za-z0-9]+$/.test(password)) {
  throw new Error(
    "CUSTOMER_API_PASSWORD may only contain letters and digits so it is safe in SQL and URLs",
  );
}
execFileSync(
  "npx",
  [
    "supabase",
    "db",
    "query",
    "--local",
    `alter role customer_api with password '${password}';`,
  ],
  { cwd: root, stdio: "inherit" },
);
const url = `postgresql://customer_api:${password}@127.0.0.1:54322/postgres`;
const envPath = join(root, ".env.local");
if (existsSync(envPath)) {
  const current = readFileSync(envPath, "utf8");
  const next = current.includes("CUSTOMER_API_DATABASE_URL=")
    ? current.replace(
        /^CUSTOMER_API_DATABASE_URL=.*$/m,
        `CUSTOMER_API_DATABASE_URL=${url}`,
      )
    : `${current.replace(/\s*$/, "\n")}CUSTOMER_API_DATABASE_URL=${url}\n`;
  writeFileSync(envPath, next);
  console.log("Updated CUSTOMER_API_DATABASE_URL in .env.local");
} else {
  console.log("CUSTOMER_API_DATABASE_URL=" + url);
  console.log("Copy that line into .env.local (do not commit it).");
}
