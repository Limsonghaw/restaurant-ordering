import { randomBytes, pbkdf2Sync, createHmac, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { npxInvocation } from './npx-command.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const envPath = fileURLToPath(new URL('../.env.production.local', import.meta.url));
const ref = 'rdhnbiualjuujveawfxb';
const host = 'aws-1-ap-northeast-1.pooler.supabase.com';
const text = readFileSync(envPath, 'utf8');
const existing = text.match(/^CUSTOMER_API_DATABASE_URL=(.*)$/m)?.[1]?.trim();
let password;
if (existing) {
  const url = new URL(existing);
  if (url.hostname !== host || decodeURIComponent(url.username) !== `customer_api.${ref}`) {
    throw new Error('Existing database connection differs; inspect it before changing credentials.');
  }
  password = decodeURIComponent(url.password);
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('Existing password needs manual review.');
} else {
  password = randomBytes(32).toString('hex');
}
// ASCII password: SASLprep leaves it unchanged. Send SCRAM verifier, not plaintext.
const salt = randomBytes(16);
const iterations = 4096;
const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
const clientKey = createHmac('sha256', salted).update('Client Key').digest();
const storedKey = createHash('sha256').update(clientKey).digest('base64');
const serverKey = createHmac('sha256', salted).update('Server Key').digest('base64');
const verifier = `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey}:${serverKey}`;
const connection = `postgresql://customer_api.${ref}:${password}@${host}:6543/postgres`;
// Save first so a failed CLI call can safely be retried with the same password.
const next = existing
  ? text.replace(/^CUSTOMER_API_DATABASE_URL=.*$/m, `CUSTOMER_API_DATABASE_URL=${connection}`)
  : `${text.trimEnd()}\nCUSTOMER_API_DATABASE_URL=${connection}\n`;
writeFileSync(envPath, next);
const npx = npxInvocation();
try {
  execFileSync(npx.command, ['supabase', 'db', 'query', '--linked', '--project-ref', ref], {
    cwd: root,
    input: `ALTER ROLE customer_api PASSWORD '${verifier}';\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: npx.shell,
  });
} catch {
  console.error('Cloud role configuration failed. Connection saved locally; retry after checking Supabase CLI login and project access.');
  process.exit(1);
}
console.log('Cloud customer_api password configured. CUSTOMER_API_DATABASE_URL saved in .env.production.local. No secrets printed.');
