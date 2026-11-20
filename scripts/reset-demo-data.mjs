import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const MAX_ALLOWED_EMAILS = 10;
const STORE_ID = 'de000010-0000-4000-8000-000000000001';
const PUBLIC_TABLE_ID = 'de000010-0000-4000-8000-000000000010';
const STORE_PREFIX = STORE_ID + '/';
const SEED_DIR = new URL('./demo-seed/', import.meta.url);
const STORAGE_PATH = '/storage/v1/object';
const BUCKET = 'menu-images';
const PAGE_SIZE = 100;
const SEED_COUNTS = { stores: 1, tables: 3, categories: 4, items: 16 };
const DELETED_FIELDS = [
  'blocked_clients', 'order_items', 'order_client_meta', 'orders',
  'bill_access_tokens', 'bills', 'audit_logs', 'stores',
];

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error('Missing ' + name);
  return value;
}

export function parseAllowedEmails(value = '') {
  const emails = [...new Set(value.toLowerCase().split(/[,\s]+/).filter(Boolean))];
  if (!emails.length || emails.length > MAX_ALLOWED_EMAILS) {
    throw new Error(`DEMO_ALLOWED_USER_EMAILS must contain 1 to ${MAX_ALLOWED_EMAILS} unique emails`);
  }
  return emails;
}

function readSigningConfig(env) {
  const siteUrl = required(env, 'DEMO_SITE_URL');
  if (!/^https?:\/\/[^/?#@\\\s]+$/i.test(siteUrl) || !URL.canParse(siteUrl)) {
    throw new Error('DEMO_SITE_URL must be an HTTP(S) origin without a trailing slash');
  }
  return { siteUrl, signingSecret: required(env, 'DEMO_QR_SIGNING_SECRET') };
}

/** @param {Record<string, string | undefined>} env */
export function readConfig(env = process.env) {
  const ref = required(env, 'DEMO_ALLOWED_PROJECT_REF');
  if (!/^[a-z0-9]+$/i.test(ref)) throw new Error('Invalid DEMO_ALLOWED_PROJECT_REF');
  const url = `https://${ref.toLowerCase()}.supabase.co`;
  const supplied = required(env, 'DEMO_SUPABASE_URL');
  const origin = supplied.replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/i.test(origin) ||
      !origin.startsWith('https://') || origin.toLowerCase() !== url) {
    throw new Error('DEMO_SUPABASE_URL does not match DEMO_ALLOWED_PROJECT_REF');
  }
  const serviceRoleKey = required(env, 'DEMO_SUPABASE_SERVICE_ROLE_KEY');
  const emails = parseAllowedEmails(env.DEMO_ALLOWED_USER_EMAILS);
  const signing = env.DEMO_SITE_URL?.trim() || env.DEMO_QR_SIGNING_SECRET?.trim()
    ? readSigningConfig(env) : undefined;
  return { url, serviceRoleKey, emails, signing };
}

/** @param {Record<string, string | undefined>} env */
export function printTableUrls(env = process.env) {
  return signPublicTableUrl(readSigningConfig(env));
}

function signPublicTableUrl({ siteUrl, signingSecret }) {
  const bytes = Buffer.alloc(34);
  Buffer.from(STORE_ID.replaceAll('-', ''), 'hex').copy(bytes);
  Buffer.from(PUBLIC_TABLE_ID.replaceAll('-', ''), 'hex').copy(bytes, 16);
  bytes.writeUInt16BE(1, 32);
  const payload = 'v1.' + bytes.toString('base64url');
  const signature = createHmac('sha256', signingSecret).update(payload)
    .digest().subarray(0, 16).toString('base64url');
  return `${siteUrl}/t/${payload}.${signature}`;
}

function createRequest(config, fetcher) {
  return async (operation, path, { method = 'POST', json, body, headers, responseJson = true }) => {
    let response;
    try {
      response = await fetcher(config.url + path, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(40_000),
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: 'Bearer ' + config.serviceRoleKey,
          ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        body: json === undefined ? body : JSON.stringify(json),
      });
    } catch {
      throw new Error(operation + ' failed (request error)');
    }
    if (!response.ok) throw new Error(`${operation} failed (HTTP ${response.status})`);
    if (!responseJson) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    try {
      return await response.json();
    } catch {
      throw new Error(operation + ' returned invalid JSON');
    }
  };
}

export async function listStoreKeys(request) {
  const keys = new Set();
  const prefixes = [STORE_PREFIX];
  for (const prefix of prefixes) {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await request('Storage list', `${STORAGE_PATH}/list/${BUCKET}`, {
        json: { prefix: prefix.slice(0, -1), limit: PAGE_SIZE, offset, sortBy: { column: 'name', order: 'asc' } },
      });
      if (!Array.isArray(page)) throw new Error('Unexpected Storage listing');
      for (const entry of page) {
        const name = entry?.name;
        if (typeof name !== 'string' || !name || /[\/\\]/.test(name) || name === '.' || name === '..') {
          throw new Error('Unexpected Storage entry name');
        }
        const key = prefix + name;
        if (entry.id === null) prefixes.push(key + '/');
        else if (typeof entry.id === 'string' && entry.id) keys.add(key);
        else throw new Error('Unexpected Storage entry type');
      }
      if (page.length < PAGE_SIZE) break;
    }
  }
  return keys;
}

export async function syncStorage(request) {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', SEED_DIR), 'utf8'));
  if (manifest.bucket !== BUCKET || manifest.contentType !== 'image/png' || !manifest.objects?.length) {
    throw new Error('Invalid demo Storage manifest');
  }
  const expected = new Map();
  for (const { key, file } of manifest.objects) {
    if (!key.startsWith(STORE_PREFIX) || !/^(?:[\w-]+\/)+[\w-]+\.png$/.test(key) ||
        !/^files\/[\w-]+\.png$/.test(file) || expected.has(key)) {
      throw new Error('Invalid demo Storage manifest entry');
    }
    expected.set(key, await readFile(new URL(file, SEED_DIR)));
  }

  const before = await listStoreKeys(request);
  const deleted = [...before].filter((key) => !expected.has(key)).sort();
  for (let start = 0; start < deleted.length; start += PAGE_SIZE) {
    await request('Storage delete', `${STORAGE_PATH}/${BUCKET}`, {
      method: 'DELETE', json: { prefixes: deleted.slice(start, start + PAGE_SIZE) }, responseJson: false,
    });
  }
  for (const [key, body] of expected) {
    const path = key.split('/').map(encodeURIComponent).join('/');
    await request('Storage upload', `${STORAGE_PATH}/${BUCKET}/${path}`, {
      body, headers: { 'Content-Type': 'image/png', 'x-upsert': 'true' }, responseJson: false,
    });
  }

  const after = await listStoreKeys(request);
  if (after.size !== expected.size || [...after].some((key) => !expected.has(key))) {
    throw new Error('Storage verification failed');
  }
  return deleted;
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

/** @param {Record<string, string | undefined>} env */
export async function resetDemo(env = process.env, fetcher = globalThis.fetch) {
  const config = readConfig(env);
  const request = createRequest(config, fetcher);
  const result = await request('Database reset', '/rest/v1/rpc/reset_demo_data', {
    json: { p_allowed_emails: config.emails },
  });
  if (result?.store_id !== STORE_ID || result.public_table_id !== PUBLIC_TABLE_ID ||
      Object.entries(SEED_COUNTS).some(([name, count]) => result[name] !== count) ||
      !isCount(result.owners) || DELETED_FIELDS.some((name) => !isCount(result.deleted?.[name]))) {
    throw new Error('Unexpected database reset result (database reset already committed)');
  }

  let deleted;
  try {
    deleted = await syncStorage(request);
  } catch (error) {
    const detail = /^Storage (?:list|upload|delete) failed \((?:HTTP \d{3}|request error)\)$/.test(error?.message)
      ? error.message : 'Storage sync failed';
    throw new Error(detail + ' (database reset already committed)');
  }
  const credentials = [config.serviceRoleKey, config.signing?.signingSecret].filter(Boolean);
  return {
    ...SEED_COUNTS,
    owners: result.owners,
    deleted: Object.fromEntries(DELETED_FIELDS.map((name) => [name, result.deleted[name]])),
    deleted_storage_keys: deleted.map((key) =>
      credentials.some((credential) => key.includes(credential)) ? '[redacted]' : key),
    ...(config.signing ? { public_table_url: signPublicTableUrl(config.signing) } : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (!args.length) console.log(JSON.stringify(await resetDemo()));
    else if (args.length === 1 && args[0] === '--print-table-urls') console.log(printTableUrls());
    else throw new Error('Usage: node scripts/reset-demo-data.mjs [--print-table-urls]');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
