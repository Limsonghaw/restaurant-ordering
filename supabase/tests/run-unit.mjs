// Run each isolated database suite sequentially and propagate every failure.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const file of readdirSync(new URL('./', import.meta.url)).filter(f => f.endsWith('.test.mjs')).sort()) {
  const result = spawnSync(process.execPath, [new URL(file, import.meta.url).pathname], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
