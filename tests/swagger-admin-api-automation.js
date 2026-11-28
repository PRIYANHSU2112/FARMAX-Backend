/* eslint-disable no-console */
/**
 * Swagger admin API automation: calls every admin API in the gateway Swagger against the running
 * stack, saves realistic TEST data and checks the rows in the database.
 *
 * Scope (user rules):
 *   - read (GET + read-like POST), create (POST to a collection) and update (PATCH/PUT) only;
 *   - DELETE and state actions (approve, cancel, dispatch, retry, status, …) are never called;
 *   - every create API is called until it has saved 5 records (--per);
 *   - updates touch only records this script created; global config is written back unchanged.
 *
 * Test data is tagged `TEST-AUTO … <RUN>` / `TA<RUN>…` so it never clashes with real rows.
 *
 * Run from backend/ with the whole stack up (gateway + 15 services):
 *   node tests/swagger-admin-api-automation.js [--base-url=http://localhost:3090] [--only=<service|path-prefix>]
 *        [--dry-run] [--skip-negative] [--per=5]
 * Reports: tests/reports/admin-api-<timestamp>.{md,json}
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* variables may already be set */
}

// ─── Options ──────────────────────────────────────────────────────────────────────────────────
const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
  }),
);
const BASE = String(
  argv['base-url'] ??
    process.env.API_BASE_URL ??
    `http://localhost:${process.env.GATEWAY_PORT ?? 3000}`,
).replace(/\/$/, '');
const PER = Number(argv.per ?? 5);
const ONLY =
  typeof argv.only === 'string'
    ? argv.only
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : null;
/** --enable: records are created active / live and the enable steps (status, submit, approve…) run on them. */
const ENABLE = Boolean(argv.enable);
const inScope = (o) => !ONLY || ONLY.some((x) => o.service === x || o.path.startsWith(x));
const DRY = Boolean(argv['dry-run']);
const NEGATIVE = !argv['skip-negative'];
const MAX_ROUNDS = 6;
const CONCURRENCY = 4;
const OTP_CODE = process.env.OTP_DEV_CODE ?? '123456';

const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const RUN_DIGITS = String(Date.now()).slice(-5);
const TAG = 'TEST-AUTO';
let seq = 0;
const nextSeq = () => ++seq;

// ─── Rules ────────────────────────────────────────────────────────────────────────────────────
/** Last path segments that are state actions (skipped: user chose create + update only). */
const ACTION_WORDS = new Set(
  `approve reject cancel retry retry-failed status resolve resolve-offline reorder publish unpublish
  block unblock submit sign-off review release release-hold hold decision decisions confirm bulk
  bulk-status bulk-confirm assign reassign archive restore verify unloaded turn-away test-connection
  sync stage scan run rollback retract resend-invite reissue reconcile receive read qc pick pack
  override occupy move match login logout handover force-logout extend expire-now exit escalate
  dispatch default convert confirm-mapping complete claim change-batch allocate activate deactivate
  suspend close reopen start void reverse lock unlock revoke reset transition check-in check-out deny
  authorize depart loading driver-link deliver deliver-override delivery-failed out-for-delivery fulfil
  return-to-warehouse settle split partial reroute relabel owner generate collect send flag lab-status
  waiver request evidence feedback share mark-paid refund refunds pay succeed fail cancellation
  approve-all reject-all mark-read read-all merge refresh-prices otp defer kyc invite accept
  recalculate recompute rebuild reindex import upload export exports notify remind test fire trigger
  enable disable toggle unassign renew seal unseal capture weighbridge pings expire discontinue reinstate
  hide unhide reactivate request-changes freeze unfreeze limit duplicate replay republish abort resend
  batch outward-pass status-changes order`
    .split(/\s+/)
    .filter(Boolean),
);
/** --enable: steps that make TEST records live, run in this order (publishing a home layout is not one). */
// `approve` needs a REAL second admin (approver ≠ submitter): it runs only when that person's login is
// in .env (APPROVER_EMAIL / APPROVER_PASSWORD). The script never creates that account; the backend
// still enforces the rule.
const HAS_APPROVER = Boolean(process.env.APPROVER_EMAIL && process.env.APPROVER_PASSWORD);
// --publish (with --enable): also publish TEST records (e.g. home layouts) — this replaces the live
// version for that page; the previous one is archived and can be rolled back
const ENABLE_STEPS = [
  'status',
  'activate',
  'submit',
  'default',
  ...(HAS_APPROVER ? ['approve'] : []),
  ...(argv.publish ? ['publish'] : []),
];
/** POST routes that only compute something (no write): run as reads. */
const READ_POSTS = new Set([
  'preview',
  'simulate',
  'simulate-matrix',
  'validate',
  'cancellation-quote',
  'quote',
  'split-preview',
  'calculate',
  'search',
]);
/** Explicit classification overrides: `METHOD path` → [kind, reason?]. */
const CLASS_OVERRIDES = {
  'POST /v1/admin/notifications': ['skip', 'sends real notifications to users (staff send)'],
};
/** Customer-side creates run 5× (one per test customer) so admin APIs have customer records. */
const CUSTOMER_CREATES = [
  ['/v1/farms/quick', 'farm'],
  ['/v1/me/addresses', 'address'],
  ['/v1/me/wishlist', 'wishlist'],
  ['/v1/cart/items', 'cartitem'],
  ['/v1/support/tickets', 'ticket'],
  ['/v1/support/company/applications', 'application'],
];
/** Customer GET lists whose items belong to the test customers (registered as test-owned). */
const CUSTOMER_LISTS = [
  ['/v1/farms', 'farm'],
  ['/v1/me/addresses', 'address'],
  ['/v1/support/tickets', 'ticket'],
];
/** Paths that move stock or money: foreign keys must point at TEST records, never real ones. */
const STRICT_FK =
  /\/(stock|inventory|wallet|refunds?|payments?|invoices?|reservations|ledger|receipts|write-offs|damage)/;
/** Resources customers see: created inactive / draft / scheduled in the future. */
const CUSTOMER_VISIBLE =
  /promotion|offer|coupon|banner|notification|home|layout|content|news|announce|campaign|faq|legal/;
/** FK field aliases used when no registry noun matches. */
const FK_ALIASES = {
  customer: '@customer',
  user: '@customer',
  farmer: '@customer',
  buyer: '@customer',
  requester: '@customer',
  recipient: '@customer',
  createdby: '@admin',
  assignee: '@admin',
  approver: '@admin',
  reviewer: '@admin',
  staff: '@admin',
  node: 'warehouse',
  productvariant: 'variant',
  sku: 'variant',
};
const AP_PINS = ['534101', '534211', '533101', '521201', '534001'];
const AP_CITIES = ['Bhimavaram', 'Tanuku', 'Eluru', 'Nuzvid', 'Rajahmundry'];
const AP_DISTRICTS = ['West Godavari', 'West Godavari', 'Eluru', 'Krishna', 'East Godavari'];
const AP_VILLAGES = ['Undi', 'Attili', 'Pedavegi', 'Hanuman Junction', 'Anaparthy'];
const FIRST = ['Ravi', 'Lakshmi', 'Srinivas', 'Padma', 'Venkatesh'];
const LAST = ['Kumar', 'Devi', 'Rao', 'Reddy', 'Naidu'];

// ─── State ────────────────────────────────────────────────────────────────────────────────────
const tokens = { admin: null, adminId: null, customers: [] };
/** noun → { test: rec[], seen: item[] } */
const registry = new Map();
const endpoints = new Map();
const mismatches = [];
const dbChecks = { verified: 0, missing: [], pendingMigrations: [] };
let spec;
let pgPool = null;
let idTables = { uuid: [], text: [] };

// ─── Small helpers ────────────────────────────────────────────────────────────────────────────
const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const singular = (w) => {
  const s = String(w);
  if (/ies$/i.test(s)) return s.slice(0, -3) + 'y';
  if (/(ss|sh|ch|x)es$/i.test(s)) return s.slice(0, -2);
  if (/sses$/i.test(s)) return s.slice(0, -2);
  if (/s$/i.test(s) && !/ss$/i.test(s)) return s.slice(0, -1);
  return s;
};
const human = (s) =>
  String(s)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
const isParam = (seg) => seg.startsWith('{');
const segsOf = (p) => p.split('/').filter(Boolean);
const clamp = (v, lo, hi) => Math.min(hi ?? Infinity, Math.max(lo ?? -Infinity, v));
const days = (n) => new Date(Date.now() + n * 86_400_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v, n = 300) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + '…' : s;
};

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift());
    }),
  );
}

function deref(s) {
  let out = s;
  for (let k = 0; out && out.$ref && k < 20; k++)
    out = out.$ref
      .split('/')
      .slice(1)
      .reduce((o, key) => o?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
  return out ?? {};
}

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────────────────────
/** Client-side pacing under the per-user limits of warehouse-service (60 writes / 5 exports a minute). */
const pace = { write: [], export: [] };
async function throttle(method, url) {
  const wms = /\/(wms|warehouses)(\/|$|\?)/.test(url);
  const kind = /export|\.csv/.test(url) ? 'export' : method !== 'GET' && wms ? 'write' : null;
  if (!kind || !wms) return;
  const max = kind === 'export' ? 4 : 50;
  for (;;) {
    const now = Date.now();
    pace[kind] = pace[kind].filter((t) => now - t < 61_000);
    if (pace[kind].length < max) break;
    await sleep(61_000 - (now - pace[kind][0]));
  }
  pace[kind].push(Date.now());
}

async function http(method, url, { token, body, headers = {} } = {}) {
  if (token) await throttle(method, url);
  const h = { accept: 'application/json', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  for (let attempt = 0; attempt < 4; attempt++) {
    const t0 = performance.now();
    try {
      const res = await fetch(BASE + url, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      const wait = Number(
        res.headers.get('retry-after') ?? json?.error?.details?.retryAfterSeconds ?? 2,
      );
      // per-user write/export limits (e.g. warehouse 60 writes/min) → wait; OTP-style long locks → give up
      if (res.status === 429 && attempt < 3 && wait <= 70) {
        await sleep(1000 * wait);
        continue;
      }
      // a service restarting behind the gateway (503) → give it up to ~30 s
      if (res.status === 503 && attempt < 3) {
        await sleep(10_000);
        continue;
      }
      return {
        status: res.status,
        ms: Math.round(performance.now() - t0),
        json,
        etag: res.headers.get('etag'),
        text: json === undefined ? text.slice(0, 300) : undefined,
      };
    } catch (e) {
      if (attempt === 3)
        return { status: 0, ms: Math.round(performance.now() - t0), error: e.message };
      await sleep(5_000);
    }
  }
  return { status: 0, ms: 0, error: 'retries exhausted' };
}

async function adminLogin() {
  const r = await http('POST', '/v1/auth/auth/admin/login', {
    body: { identifier: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD },
  });
  const d = r.json?.data;
  if (d?.status === 'mfa_required')
    throw new Error('Admin login needs MFA — disable MFA for the seed admin first.');
  if (!d?.accessToken)
    throw new Error(`Admin login failed: ${r.status} ${short(r.json ?? r.text ?? r.error)}`);
  tokens.admin = d.accessToken;
  const claims = decodeJwt(d.accessToken);
  tokens.adminId = claims.sub ?? claims.userId ?? null;
}

/** Admin call that logs in again once on 401 (runs can outlive the 60-min token). */
async function adminHttp(method, url, opts = {}) {
  let r = await http(method, url, { ...opts, token: tokens.admin });
  if (r.status === 401) {
    await adminLogin();
    r = await http(method, url, { ...opts, token: tokens.admin });
  }
  return r;
}

/** Customer refresh tokens are cached outside the repo so re-runs don't hit the OTP rate limit. */
const SESSION_FILE = path.join(os.tmpdir(), 'farmx-admin-api-customer-sessions.json');
function readSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function customerLogins() {
  const sessions = readSessions();
  for (let n = 1; n <= PER; n++) {
    const phone = `+9199999000${String(n).padStart(2, '0')}`;
    if (sessions[phone]) {
      const r = await http('POST', '/v1/auth/auth/refresh', {
        body: { refreshToken: sessions[phone] },
      });
      if (r.json?.data?.accessToken) {
        const claims = decodeJwt(r.json.data.accessToken);
        sessions[phone] = r.json.data.refreshToken ?? sessions[phone];
        tokens.customers.push({
          phone,
          token: r.json.data.accessToken,
          id: claims.sub ?? claims.userId,
        });
        continue;
      }
    }
    const send = await http('POST', '/v1/auth/auth/otp/send', { body: { phone } });
    if (send.status === 429) {
      console.warn(
        `  OTP rate-limited (otp/send 429, retry in ${send.json?.error?.details?.retryAfterSeconds ?? '?'} s): no test customers this run`,
      );
      break;
    }
    if (send.status >= 300)
      console.warn(
        `  customer ${phone}: otp/send ${send.status} ${short(send.json?.error?.message)}`,
      );
    const v = await http('POST', '/v1/auth/auth/otp/verify', {
      body: {
        phone,
        code: OTP_CODE,
        deviceId: `test-auto-device-${n}`,
        deviceName: `TEST-AUTO device ${n}`,
      },
    });
    const token = v.json?.data?.accessToken;
    if (!token) {
      console.warn(
        `  customer ${phone}: otp/verify ${v.status} ${short(v.json?.error?.message ?? v.json?.data)}`,
      );
      // OTP is rate-limited: more attempts only keep the limit hot
      if (send.status === 429 || v.status === 429) {
        console.warn('  OTP rate-limited: skipping the other test customers this run');
        break;
      }
      continue;
    }
    const claims = decodeJwt(token);
    if (v.json.data.refreshToken) sessions[phone] = v.json.data.refreshToken;
    tokens.customers.push({ phone, token, id: claims.sub ?? claims.userId });
  }
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions));
  } catch {
    /* cache is optional */
  }
}

// ─── media-service: upload real test images, used by image URL fields ──────────────────────
const UPLOADED = [];
function pngImage(w, h, [r, g, b]) {
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    const stripe = Math.floor(x / 40) % 2 === 0 ? 1 : 0.8; // light stripes so it is not a flat block
    row[1 + x * 3] = Math.round(r * stripe);
    row[2 + x * 3] = Math.round(g * stripe);
    row[3 + x * 3] = Math.round(b * stripe);
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
async function uploadImages() {
  const o = {
    key: 'POST /v1/media/upload',
    method: 'POST',
    path: '/v1/media/upload',
    service: 'media-service',
    tag: 'Media',
    kind: 'create',
  };
  const e = ep(o);
  const colours = [
    [249, 115, 22],
    [22, 163, 74],
    [37, 99, 235],
    [234, 179, 8],
    [190, 24, 93],
  ];
  for (let k = 0; k < PER; k++) {
    const fd = new FormData();
    fd.append(
      'file',
      new Blob([pngImage(640, 640, colours[k % colours.length])], { type: 'image/png' }),
      `test-auto-${RUN.toLowerCase()}-${k + 1}.png`,
    );
    const t0 = performance.now();
    let r;
    try {
      const res = await fetch(BASE + '/v1/media/upload?type=image', {
        method: 'POST',
        headers: { authorization: `Bearer ${tokens.admin}` },
        body: fd,
        signal: AbortSignal.timeout(60_000),
      });
      r = { status: res.status, json: await res.json().catch(() => undefined) };
    } catch (err) {
      r = { status: 0, error: err.message };
    }
    r.ms = Math.round(performance.now() - t0);
    const ok = ok2xx(r) && typeof r.json?.data?.url === 'string';
    record(o, 'B upload', o.path, r, ok, ok ? { note: r.json.data.url } : {});
    if (ok) {
      UPLOADED.push(r.json.data.url);
      e.created++;
    }
  }
}

// ─── Registry (ids created by this run = test-owned; ids seen in lists = read-only refs) ──────
function bucket(noun) {
  const k = norm(singular(noun));
  if (!registry.has(k)) registry.set(k, { test: [], seen: [] });
  return registry.get(k);
}
function addTest(noun, rec) {
  const b = bucket(noun);
  if (!b.test.some((r) => r.id === rec.id)) b.test.push(rec);
  const type = rec.data?.type ?? rec.body?.type ?? rec.data?.group ?? rec.body?.group;
  if (typeof type === 'string' && /^[A-Z][A-Z_]+$/.test(type) && norm(type) !== norm(noun)) {
    const tb = bucket(type);
    if (!tb.test.some((r) => r.id === rec.id)) tb.test.push(rec);
  }
}
function addSeen(noun, item, src) {
  if (!item || typeof item !== 'object' || !item.id) return;
  const b = bucket(noun);
  if (b.seen.length < 50 && !b.seen.some((x) => x.id === item.id))
    b.seen.push({ id: item.id, data: item, src });
  // typed lookups (type / group: DOSAGE_FORM / ROUTE / UNIT …) also answer dosageFormId, routeId, unitId …
  const kind = typeof item.type === 'string' ? item.type : item.group;
  if (typeof kind === 'string' && /^[A-Z][A-Z_]+$/.test(kind) && norm(kind) !== norm(noun)) {
    const tb = bucket(kind);
    if (tb.seen.length < 50 && !tb.seen.some((x) => x.id === item.id))
      tb.seen.push({ id: item.id, data: item, src });
  }
  // nested arrays of records, e.g. product.variants[] → noun "variant"
  for (const [k, v] of Object.entries(item))
    if (Array.isArray(v) && v[0] && typeof v[0] === 'object' && v[0].id)
      v.forEach((x) => addSeen(k, x, src));
}
const srcOf = (r) => (r.src ?? r.op ?? '').replace(/^[A-Z]+ /, '');
const prefixScore = (a, b) => {
  const x = segsOf(a);
  const y = segsOf(b);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
};
/**
 * Records of a bucket usable at ctx.path: the same noun lives in several services (category, topic,
 * document, rule…), so the records sharing the longest path prefix win; test-owned before seen.
 */
function candidates(b, ctx, testOnly) {
  if (!b) return [];
  const list = [
    ...b.test.map((r) => ({ r, test: true })),
    ...(testOnly ? [] : b.seen.map((r) => ({ r, test: false }))),
  ];
  if (!list.length) return [];
  const p = ctx.path ?? '';
  for (const x of list) x.score = prefixScore(srcOf(x.r), p);
  const best = Math.max(...list.map((x) => x.score));
  const top = list.filter((x) => x.score === best);
  const tests = top.filter((x) => x.test);
  return (tests.length ? tests : top).map((x) => x.r);
}
const CUSTOMER_PATH =
  /wallet|customer|address|wishlist|farm|order|ticket|review|payments-view|reward|cart|invoice/;

/** Resolve a registry bucket for a noun: exact, then suffix match either way. */
function findBucket(noun) {
  const k = norm(singular(noun));
  if (!k) return null;
  if (registry.has(k)) return registry.get(k);
  let best = null;
  for (const [name, b] of registry) {
    if (!(b.test.length || b.seen.length)) continue;
    if (
      (name.endsWith(k) || k.endsWith(name)) &&
      name.length >= 3 &&
      (!best || name.length > best[0].length)
    )
      best = [name, b];
  }
  return best?.[1] ?? null;
}

/** Pick an id for an FK-like field or path param. */
function pickId(noun, ctx, { testOnly = false } = {}) {
  const n = norm(singular(noun));
  const j = (ctx.i ?? 1) - 1 + (ctx.j ?? 0);
  const fromBucket = (b) => {
    const c = candidates(b, ctx, testOnly);
    return c.length ? c[j % c.length].id : null;
  };
  const customer = () =>
    tokens.customers.length ? tokens.customers[j % tokens.customers.length].id : null;
  if (n === 'parent' && ctx.noun) return fromBucket(findBucket(ctx.noun));
  const alias = FK_ALIASES[n];
  // customer / farmer / buyer / requester always mean a test customer; `user` does on customer screens
  if (alias === '@customer' && (n !== 'user' || CUSTOMER_PATH.test(ctx.path ?? ''))) {
    const c = customer();
    if (c) return c;
  }
  const direct = fromBucket(findBucket(n));
  if (direct) return direct;
  if (alias === '@customer') return customer();
  if (alias === '@admin') return tokens.adminId;
  if (alias) return fromBucket(findBucket(alias));
  return null;
}

// ─── Regex → sample string (subset: classes, groups, alternation, quantifiers) ────────────────
function fromRegex(src, seed = 1) {
  const uniqDigits = (
    String(seed).padStart(4, '0') +
    RUN_DIGITS +
    String(Date.now()).slice(-6)
  ).split('');
  const s = src.replace(/^\^/, '').replace(/\$$/, '');
  let i = 0;
  const esc = (c) => {
    if (c === 'd') return '0123456789'.split('');
    if (c === 'w') return 'ABCDEFGHJKabcdefgh0123456789'.split('');
    if (c === 's') return [' '];
    return [c];
  };
  const parseAlt = () => {
    const alts = [parseSeq()];
    while (s[i] === '|') {
      i++;
      alts.push(parseSeq());
    }
    return { alts };
  };
  const parseSeq = () => {
    const items = [];
    while (i < s.length && s[i] !== '|' && s[i] !== ')') items.push(parseQuant(parseAtom()));
    return { seq: items };
  };
  const parseAtom = () => {
    const c = s[i++];
    if (c === '(') {
      if (s[i] === '?') i += 2;
      const g = parseAlt();
      i++;
      return { group: g };
    }
    if (c === '[') {
      let neg = false;
      if (s[i] === '^') {
        neg = true;
        i++;
      }
      const chars = [];
      while (i < s.length && s[i] !== ']') {
        let a = s[i++];
        if (a === '\\') {
          chars.push(...esc(s[i++]));
          continue;
        }
        if (s[i] === '-' && s[i + 1] !== ']' && s[i + 1] !== undefined) {
          i++;
          let b = s[i++];
          if (b === '\\') b = s[i++];
          for (let k = a.charCodeAt(0); k <= b.charCodeAt(0); k++)
            chars.push(String.fromCharCode(k));
          continue;
        }
        chars.push(a);
      }
      i++;
      if (neg) return { set: ['a', 'B', '7', 'x'].filter((x) => !chars.includes(x)) };
      return { set: chars };
    }
    if (c === '\\') return { set: esc(s[i++]) };
    if (c === '.') return { set: ['a'] };
    if (c === '^' || c === '$') return { seq: [] };
    return { set: [c] };
  };
  const parseQuant = (atom) => {
    let min;
    let max;
    const c = s[i];
    if (c === '?') [min, max] = [0, 1];
    else if (c === '*') [min, max] = [0, Infinity];
    else if (c === '+') [min, max] = [1, Infinity];
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(s.slice(i));
      if (m) {
        min = Number(m[1]);
        max = m[2] ? (m[3] ? Number(m[3]) : Infinity) : min;
        i += m[0].length - 1;
      } else return atom;
    } else return atom;
    i++;
    if (s[i] === '?') i++;
    return { atom, min, max };
  };
  let pos = 0;
  const gen = (node) => {
    if (node.alts) return gen(node.alts[0]);
    if (node.seq) return node.seq.map(gen).join('');
    if (node.group) return gen(node.group);
    if (node.set) {
      pos++;
      // digit runs come from a run + seed unique string, so generated codes don't repeat across runs
      if (node.set.length && node.set.every((c) => c >= '0' && c <= '9')) {
        const d = uniqDigits[(pos - 1) % uniqDigits.length];
        return node.set.includes(d) ? d : node.set[Number(d) % node.set.length];
      }
      return node.set.length ? node.set[(seed * 7 + pos * 13) % node.set.length] : 'a';
    }
    if (node.atom) {
      const count =
        node.min === node.max ? node.min : node.min === 0 ? 0 : clamp(4, node.min, node.max);
      let out = '';
      for (let k = 0; k < count; k++) out += gen(node.atom);
      return out;
    }
    return '';
  };
  try {
    return gen(parseAlt());
  } catch {
    return null;
  }
}
const matches = (pattern, v) => {
  if (!pattern) return true;
  try {
    return new RegExp(pattern).test(v);
  } catch {
    return true;
  }
};

// ─── Realistic value generators ───────────────────────────────────────────────────────────────
function gstin(i) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const pan = `AAB${'CFPH'[i % 4]}T${String(1000 + ((Number(RUN_DIGITS) + i) % 9000)).padStart(4, '0')}${'ABCDE'[i % 5]}`;
  const base = `37${pan}${(i % 9) + 1}Z`;
  let sum = 0;
  for (let k = 0; k < 14; k++) {
    const p = chars.indexOf(base[k]) * (k % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return base + chars[(36 - (sum % 36)) % 36];
}
const panOf = (i) =>
  `AAB${'CFPH'[i % 4]}T${String(1000 + ((Number(RUN_DIGITS) + i) % 9000))}${'ABCDE'[i % 5]}`;
const phone10 = () => `9${RUN_DIGITS}${String(nextSeq()).padStart(4, '0')}`.slice(0, 10);

function sentence(ctx, key) {
  return `${TAG} ${human(key)} for ${human(ctx.noun ?? 'record')} #${ctx.i} — automated QA run ${RUN}, verified by the Swagger admin API suite.`;
}

function dateFor(key, ctx) {
  const k = key.toLowerCase();
  const visible = CUSTOMER_VISIBLE.test(ctx.path ?? '') && !ENABLE;
  if (/dob|birth/.test(k)) return new Date('1988-06-15T00:00:00.000Z');
  if (
    /mfg|manufactur|received|collected|issued|occurred|incident|happened|reported|performed|tested|sampled|analy|joined|purchase|billed|invoicedate|billdate|lastseen|recorded|reference|published|asof|retrieved|accessed|captured|signed/.test(
      k,
    )
  )
    return days(-2 - ctx.i);
  if (/expir|bestbefore|shelf/.test(k)) return days(365 + ctx.i);
  if (
    k === 'to' ||
    /end|until|till|close|due|deadline|finish|valid(to|upto)/.test(k) ||
    /To$/.test(key)
  )
    return days((visible ? 90 : 30) + ctx.i);
  // ENABLE: live a few minutes from now (start dates must usually be in the future)
  return ENABLE
    ? new Date(Date.now() + 5 * 60_000 + ctx.i * 1000)
    : days((visible ? 60 : 1) + ctx.i);
}

function timeFor(key) {
  return /close|end|to$|till|until/i.test(key) ? '18:00' : '09:00';
}

function stringFor(key, schema, ctx, hint) {
  const k = key.toLowerCase();
  const i = ctx.i;
  const fmt = schema.format;
  const pattern = schema.pattern;
  const candidates = [];
  const nounLabel = human(ctx.noun ?? 'record');

  if (fmt === 'uuid') return fkValue(key, ctx);
  if (fmt === 'date-time') return dateFor(key, ctx).toISOString();
  if (fmt === 'date' || (pattern && /\\d\{4\}-/.test(pattern) && !/T|:/.test(pattern)))
    return dateFor(key, ctx).toISOString().slice(0, 10);
  // placeholders like {{vetName}} in a template example would need declared variables
  if (typeof hint === 'string' && hint.includes('{{'))
    hint = hint.replace(/\{\{\s*[\w.]+\s*\}\}/g, 'farmer');
  // reference values (permission keys, topic codes…) for array items and *Code / *Key fields
  if (
    (ctx.arrayItem || /[a-z](code|key)$/.test(k)) &&
    !/^(pincode|hsncode|statecode|countrycode|postalcode)$/.test(k)
  ) {
    const ref = codeRef(ctx.arrayItem ? `${key}Key` : key, ctx);
    if (ref) return ref;
  }
  if (fmt === 'email' || /email/.test(k))
    candidates.push(`test.auto.${RUN.toLowerCase()}.${nextSeq()}@example.com`);
  else if (
    UPLOADED.length &&
    /image|logo|icon|thumb|banner|photo|picture|avatar|cover|^url$/.test(k)
  )
    candidates.push(UPLOADED[(i - 1) % UPLOADED.length]);
  else if (fmt === 'uri' || /url$|link$|website|^uri$/.test(k))
    candidates.push(
      typeof hint === 'string' && /^https?:/.test(hint)
        ? hint
        : `https://cdn.example.com/test-auto/${norm(ctx.noun ?? 'file')}-${i}.webp`,
    );
  else if (/desc|subtitle|caption/.test(k))
    candidates.push(
      typeof hint === 'string' && hint.length >= (schema.minLength ?? 0)
        ? hint
        : sentence(ctx, key),
    );
  else if (/phone|mobile|whatsapp|contactnumber|msisdn/.test(k)) {
    const ten = phone10();
    candidates.push(`+91${ten}`, ten, `91${ten}`);
  } else if (/pincode|pin_code|postalcode|zipcode|^pin$|^zip$/.test(k))
    candidates.push(AP_PINS[(i - 1) % 5]);
  else if (/gstin|gstno|gstnumber/.test(k)) candidates.push(gstin(i + nextSeq()));
  else if (/^pan|pannumber|panno/.test(k)) candidates.push(panOf(i));
  else if (/ifsc/.test(k)) candidates.push('SBIN0004321');
  else if (/hsn/.test(k)) candidates.push('30023000');
  else if (/barcode|ean|gtin|upc/.test(k))
    candidates.push(`890${RUN_DIGITS}${String(nextSeq()).padStart(5, '0')}`.slice(0, 13));
  else if (/^statecode$/.test(k)) candidates.push('37', 'AP');
  else if (/countrycode|^country$/.test(k)) candidates.push('IN', 'India');
  else if (/currency/.test(k)) candidates.push('INR');
  else if (/timezone|^tz$/.test(k)) candidates.push('Asia/Kolkata');
  else if (/^(language|locale|lang)$/.test(k)) candidates.push('en', 'en-IN');
  else if (/colou?r/.test(k)) candidates.push('#F97316');
  else if (/vehicle(no|number|reg)|registration(no|number)|^regno$/.test(k))
    candidates.push(`AP37AB${String(1000 + nextSeq()).slice(-4)}`);
  else if (/batch(no|number|code)?$|^lot(no|number)?$/.test(k))
    candidates.push(`B${RUN}${nextSeq()}`);
  else if (/invoice(no|number)/.test(k)) candidates.push(`INV-${RUN}-${nextSeq()}`);
  else if (/slug/.test(k))
    candidates.push(`test-auto-${norm(ctx.noun ?? 'rec')}-${RUN.toLowerCase()}-${nextSeq()}`);
  else if (/(^|[a-z])code$/.test(k) && k !== 'code')
    candidates.push(`TA${RUN}${nextSeq()}`, `TA_${RUN}_${nextSeq()}`);
  else if (/^key$|[a-z]key$/.test(k))
    candidates.push(
      `ta${RUN}${nextSeq()}`,
      `ta_${RUN.toLowerCase()}_${nextSeq()}`,
      `TA${RUN}${nextSeq()}`,
    );
  else if (/^(code|sku|externalref|reference|ref|refno|referenceno)$/.test(k))
    candidates.push(
      `TA${RUN}${nextSeq()}`,
      `TA_${RUN}_${nextSeq()}`,
      `ta_${RUN.toLowerCase()}_${nextSeq()}`,
    );
  else if (/firstname/.test(k)) candidates.push(FIRST[(i - 1) % 5]);
  else if (/lastname|surname/.test(k)) candidates.push(LAST[(i - 1) % 5]);
  else if (
    /(full|contact|owner|person|driver|visitor|holder|customer|farmer|vendor)name|^contactperson$/.test(
      k,
    )
  )
    candidates.push(`${FIRST[(i - 1) % 5]} ${LAST[(i - 1) % 5]}`);
  else if (
    /^(name|title|label|heading|displayname|businessname|legalname|tradename|companyname)$|name$|title$/.test(
      k,
    )
  )
    candidates.push(`${TAG} ${nounLabel} ${i} ${RUN}`);
  else if (/city|town/.test(k)) candidates.push(AP_CITIES[(i - 1) % 5]);
  else if (/district/.test(k)) candidates.push(AP_DISTRICTS[(i - 1) % 5]);
  else if (/^state$|statename/.test(k)) candidates.push('Andhra Pradesh');
  else if (/mandal|taluk|tehsil/.test(k)) candidates.push(AP_CITIES[(i - 1) % 5]);
  else if (/village/.test(k)) candidates.push(AP_VILLAGES[(i - 1) % 5]);
  else if (/line2/.test(k)) candidates.push('Near APSRTC Bus Stand');
  else if (/landmark/.test(k)) candidates.push('Opp. Sri Venkateswara Temple');
  else if (/address|line1|street/.test(k))
    candidates.push(`Plot ${10 + i}, Poultry Farm Road, ${AP_CITIES[(i - 1) % 5]}`);
  else if (
    /(time|opens|closes|opensat|closesat|from|to|start|end|cutoff)$/.test(k) &&
    pattern &&
    /:/.test(pattern)
  )
    candidates.push(timeFor(key), '09:00:00');
  else if (
    /desc|notes?$|remark|reason|comment|message|body|content|summary|detail|instruction|text|answer|question|subtitle|caption|purpose|justification|narration|observation|finding|resolution/.test(
      k,
    )
  )
    candidates.push(
      typeof hint === 'string' && hint.length >= (schema.minLength ?? 0)
        ? hint
        : sentence(ctx, key),
    );

  if (typeof hint === 'string' && !candidates.length) candidates.push(hint);
  candidates.push(`${TAG} ${human(key)} ${i} ${RUN}`, `TA${RUN}${nextSeq()}`);
  if (pattern) candidates.push(fromRegex(pattern, nextSeq()));

  for (let c of candidates) {
    if (c == null) continue;
    if (schema.maxLength && c.length > schema.maxLength) c = c.slice(0, schema.maxLength).trim();
    if (schema.minLength && c.length < schema.minLength)
      c = c
        .padEnd(schema.minLength, ' QA test'.repeat(4))
        .slice(0, Math.max(schema.minLength, c.length));
    if (matches(pattern, c)) return c;
  }
  return candidates.find((c) => c != null);
}

/**
 * `topicCode`, `permissionKey`, `permissions[]` … → the `code` / `key` of a registry record of that
 * noun (a real reference value instead of an invented one).
 */
function codeRef(key, ctx) {
  const noun = key.replace(/(Code|Key)s?$/, '');
  const b = findBucket(noun);
  if (!b) return null;
  const pool = candidates(b, ctx, false).map((r) => r.data ?? r.body ?? {});
  for (const f of ['code', 'key']) {
    const withField = pool.filter((x) => typeof x?.[f] === 'string');
    if (withField.length) return withField[((ctx.i ?? 1) - 1 + (ctx.j ?? 0)) % withField.length][f];
  }
  return null;
}

/** Random ids handed out for unresolved FKs: optional fields holding one are dropped. */
const UNRESOLVED = new Set();
function fkValue(key, ctx) {
  const base = key.replace(/(Ids?|_ids?|Id)$/i, '') || key;
  const strict = STRICT_FK.test(ctx.path ?? '');
  const id = pickId(base, ctx, { testOnly: strict || ctx.round === 1 });
  if (id) return id;
  ctx.unresolved?.add(base);
  const fake = randomUUID();
  UNRESOLVED.add(fake);
  return fake;
}
const holdsUnresolved = (v) =>
  (typeof v === 'string' && UNRESOLVED.has(v)) ||
  (Array.isArray(v) && v.some((x) => typeof x === 'string' && UNRESOLVED.has(x)));

function numberFor(key, schema, ctx, hint, integer) {
  const k = key.toLowerCase();
  const i = ctx.i;
  let v;
  if (typeof hint === 'number') v = hint;
  else if (/lat/.test(k)) v = 16.54 + i * 0.03;
  else if (/lng|lon/.test(k)) v = 81.52 + i * 0.03;
  else if (/accuracy/.test(k)) v = 12;
  else if (/percent|pct|discount|gst|tax|margin|commission/.test(k))
    v = [5, 12, 18, 5, 12][(i - 1) % 5];
  else if (/mrp/.test(k)) v = 550 + i * 50;
  else if (/paise/.test(k)) v = (450 + i * 50) * 100;
  else if (/price|amount|cost|value|fee|charge|total|rate|budget|limit|threshold|balance/.test(k))
    v = 450 + i * 50;
  else if (/temp/.test(k)) v = /max|high/.test(k) ? 8 : 2;
  else if (/weight|kg|tonn/.test(k)) v = 25 + i;
  else if (/birds|flock|capacity|stock|qty|quantity|units|count|size|pack/.test(k)) v = 10 * i;
  else if (/day|days/.test(k)) v = 7 + i;
  else if (/month/.test(k)) v = 6;
  else if (/minute/.test(k) && /start|open|from|begin/.test(k)) v = 540;
  else if (/minute/.test(k) && /end|close|to$|until|till/.test(k)) v = 1080;
  else if (/hour/.test(k) && /start|open|from|begin/.test(k)) v = 9;
  else if (/hour/.test(k) && /end|close|to$|until|till/.test(k)) v = 18;
  else if (/hour/.test(k)) v = 8 + (i % 4);
  else if (/minute|min$|sla|duration|timeout/.test(k)) v = 30;
  else if (/order|position|rank|priority|sequence|sort|level|step/.test(k)) v = i;
  else if (/year/.test(k)) v = 2026;
  else if (/version$/.test(k)) v = 0;
  else v = i + 1;
  if (typeof hint !== 'number') {
    if (/^min/.test(k)) v = Math.max(1, Math.floor(v / 5));
    if (/^max/.test(k)) v *= 10;
  }
  const lo =
    schema.minimum !== undefined
      ? schema.minimum + (schema.exclusiveMinimum === true ? 1 : 0)
      : undefined;
  const hi =
    schema.maximum !== undefined
      ? schema.maximum - (schema.exclusiveMaximum === true ? 1 : 0)
      : undefined;
  v = clamp(v, lo, hi);
  if (integer) v = Math.round(v);
  else v = Math.round(v * 100) / 100;
  return v;
}

function boolFor(key, ctx, hint) {
  const k = key.toLowerCase();
  if (/^is(required|mandatory)$/.test(k)) return false; // a required attribute would block every product of that category
  if (ENABLE && /^requires?[A-Z_]/.test(key)) return false; // compliance flags would block submitting the TEST products
  if (ENABLE && /^is(primary|default)$/.test(k)) return true;
  if (/active|enabled|published|visible|live/.test(k) && ENABLE) return true;
  if (
    /active|enabled|published|visible|live|featured/.test(k) &&
    CUSTOMER_VISIBLE.test(ctx.path ?? '')
  )
    return false;
  if (typeof hint === 'boolean') return hint;
  if (/active|enabled|available|allowed/.test(k)) return true;
  if (/default|primary/.test(k)) return ctx.i === 1;
  if (/^(is|has|requires?|send|notify|callback|personali)/.test(k)) return ctx.i % 2 === 1;
  return true;
}

function enumFor(values, key, ctx, hint) {
  const vals = values.filter((v) => v !== null && v !== '');
  if (!vals.length) return values[0];
  const k = key.toLowerCase();
  if (k === 'status' || k.endsWith('status') || k === 'state') {
    const prefs = ENABLE
      ? ['ACTIVE', 'PUBLISHED', 'LIVE', 'APPROVED', 'ENABLED', 'OPEN']
      : CUSTOMER_VISIBLE.test(ctx.path ?? '')
        ? ['DRAFT', 'INACTIVE', 'PAUSED', 'DISABLED', 'SCHEDULED']
        : ['ACTIVE', 'DRAFT', 'PENDING', 'OPEN', 'NEW'];
    const p = prefs.find((x) => vals.includes(x) || vals.includes(x.toLowerCase()));
    if (p) return vals.includes(p) ? p : p.toLowerCase();
  }
  if (ENABLE && k === 'kind' && vals.includes('IMAGE')) return 'IMAGE';
  if (ctx.safe && hint !== undefined && vals.includes(hint)) return hint;
  if (ctx.safe) return vals[0];
  return vals[(ctx.i - 1 + (ctx.update ? 1 : 0)) % vals.length];
}

/** `actionTarget` / `targetId` follow their sibling `…Type` (CATEGORY → a category id, NONE → omitted). */
/**
 * `cloneFromId` / `copyFromId`: clone the LIVE record of the same kind (same page when given), so a
 * TEST copy keeps real content instead of starting blank.
 */
function fixClone(out, ctx, schema) {
  const key = Object.keys(schema?.properties ?? out).find((k) =>
    /^(cloneFrom|copyFrom|template)(Id)?$/.test(k),
  );
  if (!key) return;
  const live = (findBucket(ctx.noun)?.seen ?? []).filter(
    (r) =>
      /^(PUBLISHED|ACTIVE|LIVE)$/.test(r.data?.status ?? '') &&
      (out.page === undefined || r.data?.page === out.page),
  );
  if (live.length) out[key] = live[0].id;
  else Reflect.deleteProperty(out, key);
}

function fixTargets(out, ctx) {
  const typeKey = Object.keys(out).find((t) => /type$/i.test(t) && typeof out[t] === 'string');
  if (!typeKey) return;
  for (const k of Object.keys(out)) {
    if (!/target(id)?$/i.test(k)) continue;
    const t = String(out[typeKey]);
    if (/^NONE$/i.test(t)) Reflect.deleteProperty(out, k);
    else if (/URL/i.test(t)) out[k] = 'https://www.example.com/test-auto';
    else if (/DEEP/i.test(t)) out[k] = 'farmx://products';
    else {
      const id = pickId(t, ctx);
      if (id) out[k] = id;
    }
  }
}

/** JSON schema (joi-to-swagger) → realistic value. `hint` = the Swagger example at this spot. */
function build(schemaIn, ctx, key = '', depth = 0, hint) {
  let schema = deref(schemaIn);
  if (schema.allOf) schema = Object.assign({}, ...schema.allOf.map(deref));
  const alts = schema.oneOf ?? schema.anyOf;
  if (alts && !schema.properties && !schema.type) {
    const real = alts.map(deref).filter((s) => s.type || s.properties || s.enum || s.format);
    if (!real.length) return hint;
    // Joi .when() branches: take the branch the Swagger example satisfies, else the first one
    const h = hint ?? schema.example;
    const fits = (s) =>
      h !== undefined &&
      (s.enum ? s.enum.includes(h) : true) &&
      (s.type === 'string'
        ? typeof h === 'string' && matches(s.pattern, h)
        : s.type === 'object'
          ? h && typeof h === 'object'
          : s.type
            ? typeof h === s.type || (s.type === 'integer' && Number.isInteger(h))
            : true);
    const pick = real.find(fits) ?? real[0];
    return build(
      { ...pick, ...(schema.example ? { example: schema.example } : {}) },
      ctx,
      key,
      depth,
      hint,
    );
  }
  if (hint === undefined && schema.example !== undefined && depth > 0) hint = schema.example;
  if (schema.enum?.length) return enumFor(schema.enum, key, ctx, hint);
  const type = schema.type ?? (schema.properties ? 'object' : schema.items ? 'array' : 'string');
  if (type === 'object') {
    const out = {};
    const required = new Set(schema.required ?? []);
    const hasHint = hint && typeof hint === 'object';
    const childCtx = ctx.arrayItem ? { ...ctx, arrayItem: false } : ctx;
    for (const [k, s] of Object.entries(schema.properties ?? {})) {
      const ds = deref(s);
      if (ds.readOnly) continue;
      if (depth > 4 && !required.has(k)) continue;
      if (/^(version|idempotencyKey)$/.test(k) && !required.has(k)) continue;
      // minimal fallback: required fields + the fields the Swagger example uses
      if (ctx.minimal && !required.has(k) && !(hasHint && hint[k] !== undefined)) continue;
      // ENABLE: product media is the product's own primary image (a variant image does not count)
      if (ENABLE && k === 'variantId' && !required.has(k) && (ctx.path ?? '').endsWith('/media'))
        continue;
      // ENABLE: no hazard class (it would demand an SDS document before the product can be submitted)
      if (ENABLE && /^(hazardClass|unNumber)$/.test(k) && !required.has(k)) continue;
      const v = build(ds, childCtx, k, depth + 1, hasHint ? hint[k] : undefined);
      if (v === undefined) continue;
      if (!required.has(k) && holdsUnresolved(v)) continue; // optional FK with no record → leave out
      out[k] = v;
    }
    // free-form maps (properties: {}) such as product `attributes` are category-specific: start empty
    if (
      !Object.keys(out).length &&
      hint &&
      typeof hint === 'object' &&
      !Array.isArray(hint) &&
      Object.keys(schema.properties ?? {}).length
    )
      return hint;
    fixTargets(out, ctx);
    fixClone(out, ctx, schema);
    return out;
  }
  if (type === 'array') {
    const items = deref(schema.items ?? {});
    if (ENABLE && /^required[A-Z]/.test(key) && !(schema.minItems > 0)) return [];
    // arrays of per-day rows (operating hours, calendars): one row per weekday
    const dayKey = Object.keys(items.properties ?? {}).find(
      (k) => /day/i.test(k) && deref(items.properties[k]).enum?.length >= 5,
    );
    const days = dayKey ? deref(items.properties[dayKey]).enum : null;
    const n = days
      ? Math.min(days.length, schema.maxItems ?? days.length)
      : clamp(Math.max(schema.minItems ?? 1, 1), 1, schema.maxItems ?? 2);
    const out = [];
    for (let j = 0; j < n; j++) {
      const h = Array.isArray(hint) && hint.length ? hint[j % hint.length] : undefined;
      const item = build(items, { ...ctx, j, arrayItem: true }, singular(key), depth + 1, h);
      if (days && item && typeof item === 'object') item[dayKey] = days[j];
      out.push(item);
    }
    if (items.enum && n > 1) return [...new Set(out)];
    return out;
  }
  if (type === 'boolean') return boolFor(key, ctx, hint);
  if (type === 'integer' || type === 'number')
    return numberFor(key, schema, ctx, hint, type === 'integer');
  return stringFor(key, schema, ctx, typeof hint === 'string' ? hint : undefined);
}

/** Schema node at a dotted body path (for 422 repair). */
function schemaAt(schema, segs) {
  let s = deref(schema);
  for (const seg of segs) {
    if (!s) return null;
    if (s.oneOf || s.anyOf) s = deref((s.oneOf ?? s.anyOf).find((x) => deref(x).type) ?? {});
    if (/^\d+$/.test(seg)) s = deref(s.items);
    else s = deref(s.properties?.[seg]);
  }
  return s && Object.keys(s).length ? s : null;
}
const getAt = (obj, segs) => segs.reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setAt(obj, segs, v) {
  let o = obj;
  for (let k = 0; k < segs.length - 1; k++) {
    if (o[segs[k]] == null || typeof o[segs[k]] !== 'object')
      o[segs[k]] = /^\d+$/.test(segs[k + 1]) ? [] : {};
    o = o[segs[k]];
  }
  o[segs.at(-1)] = v;
}
function delAt(obj, segs) {
  const parent = getAt(obj, segs.slice(0, -1));
  if (parent && typeof parent === 'object') {
    if (Array.isArray(parent)) parent.splice(Number(segs.at(-1)), 1);
    else Reflect.deleteProperty(parent, segs.at(-1));
    return true;
  }
  return false;
}

/** Apply fixes for Joi 422 issues. Returns true when the body changed. */
function repair(body, issues, op, ctx, memo) {
  let changed = false;
  for (const { path: p = '', message: m = '' } of issues) {
    if (/^(query|params|headers)\b/.test(p)) continue;
    // service-side rules report paths without "body." and with [n] indexes
    const segs = p
      .replace(/^body\.?/, '')
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.')
      .filter(Boolean);
    const unknownCode = /Unknown ([A-Z][A-Z_]+) code/.exec(m);
    if (unknownCode && segs.length) {
      const pool = candidates(findBucket(unknownCode[1]), ctx, false)
        .map((r) => r.data ?? r.body ?? {})
        .filter((x) => typeof x.code === 'string');
      if (pool.length) {
        setAt(body, segs, pool[(ctx.i - 1) % pool.length].code);
        changed = true;
        continue;
      }
    }
    const key = segs.at(-1) ?? '';
    const sch = schemaAt(op.schema, segs);
    const peer = /conflict with forbidden peer "?([\w.]+)"?/.exec(m);
    let mm;
    if ((mm = /conflict between (optional )?exclusive peers \[(.*?)\]/.exec(m))) {
      // keep only the last peer (e.g. orderId vs pinCode → keep pinCode)
      const peers = mm[2].split(/,\s*/);
      for (const pr of peers.slice(0, -1))
        if (delAt(body, [...segs, pr])) {
          memo.drop.add([...segs, pr].join('.'));
          changed = true;
        }
    } else if (/must be \[null\]/.test(m)) {
      setAt(body, segs, null);
      memo.force.set(segs.join('.'), null);
      changed = true;
    } else if (/(less|greater) than (or equal to )?"now"/.test(m)) {
      setAt(body, segs, (/less/.test(m) ? days(-3) : days(2)).toISOString());
      changed = true;
    } else if (peer || /is not allowed|must not exist simultaneously|forbidden/.test(m)) {
      if (segs.length && delAt(body, segs)) {
        memo.drop.add(segs.join('.'));
        changed = true;
      }
    } else if ((mm = /must be one of \[(.*)\]/.exec(m))) {
      const vals = mm[1]
        .split(/,\s*/)
        .map((v) => v.replace(/^"|"$/g, ''))
        .filter((v) => v && v !== 'null');
      const cur = getAt(body, segs);
      const nextVal = vals.find((v) => v !== cur) ?? vals[0];
      if (nextVal !== undefined) {
        const typed =
          typeof cur === 'number' && !Number.isNaN(Number(nextVal)) ? Number(nextVal) : nextVal;
        setAt(body, segs, typed);
        memo.force.set(segs.join('.'), typed);
        changed = true;
      }
    } else if ((mm = /must be (less|greater) than or equal to (-?[\d.]+)/.exec(m))) {
      setAt(body, segs, Number(mm[2]));
      changed = true;
    } else if ((mm = /must be (less|greater) than (-?[\d.]+)/.exec(m))) {
      setAt(body, segs, Number(mm[2]) + (mm[1] === 'greater' ? 1 : -1));
      changed = true;
    } else if ((mm = /must be (greater|larger) than (or equal to )?"?(ref:)?([\w.]+)"?/.exec(m))) {
      // Joi refs are relative to the sibling level
      const ref =
        getAt(body, [...segs.slice(0, -1), ...mm[4].split('.')]) ?? getAt(body, mm[4].split('.'));
      if (typeof ref === 'number') {
        setAt(body, segs, ref + (Number.isInteger(ref) && ref > 100 ? 60 : 1));
        changed = true;
      } else {
        const base = ref ? new Date(ref) : days(1);
        if (!Number.isNaN(base.getTime())) {
          setAt(body, segs, new Date(base.getTime() + 86_400_000 * 7).toISOString());
          changed = true;
        }
      }
    } else if ((mm = /length must be less than or equal to (\d+)/.exec(m))) {
      const cur = getAt(body, segs);
      if (typeof cur === 'string') setAt(body, segs, cur.slice(0, Number(mm[1])));
      else if (Array.isArray(cur)) setAt(body, segs, cur.slice(0, Number(mm[1])));
      changed = true;
    } else if ((mm = /length must be at least (\d+)/.exec(m))) {
      const cur = String(getAt(body, segs) ?? '');
      setAt(body, segs, cur.padEnd(Number(mm[1]), ' — automated QA test text'));
      changed = true;
    } else if ((mm = /must contain at least (\d+) items/.exec(m))) {
      const cur = getAt(body, segs) ?? [];
      const item = cur[0] ?? (sch?.items ? build(sch.items, ctx, singular(key)) : 'TA');
      setAt(
        body,
        segs,
        Array.from({ length: Number(mm[1]) }, () => structuredClone(item)),
      );
      changed = true;
    } else if (/must be a valid GUID|must be a valid UUID/.test(m)) {
      setAt(body, segs, fkValue(key, ctx));
      changed = true;
    } else if (/is required/.test(m)) {
      const v = sch
        ? build(sch, ctx, key, 1)
        : /id$/i.test(key)
          ? fkValue(key, ctx)
          : `${TAG} ${human(key)} ${ctx.i}`;
      setAt(body, segs, v);
      changed = true;
    } else if (/must be a valid email/.test(m)) {
      setAt(body, segs, `test.auto.${RUN.toLowerCase()}.${nextSeq()}@example.com`);
      changed = true;
    } else if (/must be a number/.test(m)) {
      setAt(body, segs, 1);
      changed = true;
    } else if (/must be a boolean/.test(m)) {
      setAt(body, segs, true);
      changed = true;
    } else if (/must be an integer/.test(m)) {
      setAt(body, segs, Math.round(Number(getAt(body, segs)) || 1));
      changed = true;
    } else if (/must be a valid date|must be in ISO/.test(m)) {
      setAt(body, segs, dateFor(key, ctx).toISOString());
      changed = true;
    } else if (/must be a string/.test(m)) {
      setAt(body, segs, `${TAG} ${human(key)} ${ctx.i}`);
      changed = true;
    } else if (/must be an array/.test(m)) {
      setAt(body, segs, []);
      changed = true;
    } else if (/must be of type object|must be an object/.test(m)) {
      setAt(body, segs, sch ? build(sch, ctx, key, 1) : {});
      changed = true;
    } else if (/fails to match|pattern/.test(m) && sch?.pattern) {
      const v = fromRegex(sch.pattern, nextSeq());
      if (v != null && v !== getAt(body, segs)) {
        setAt(body, segs, v);
        changed = true;
      }
    }
  }
  return changed;
}

function applyMemo(body, memo) {
  for (const p of memo.drop) delAt(body, p.split('.'));
  for (const [p, v] of memo.force)
    if (getAt(body, p.split('.').slice(0, -1)) !== undefined || !p.includes('.'))
      setAt(body, p.split('.'), v);
}

// ─── Operations ───────────────────────────────────────────────────────────────────────────────
function loadOps() {
  const tagService = Object.fromEntries(
    (spec.tags ?? []).map((t) => [
      t.name,
      (/`([a-z-]+)`/.exec(t.description ?? '') ?? [])[1] ?? 'unknown',
    ]),
  );
  const ops = [];
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = item[m];
      if (!op) continue;
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(deref);
      const rb = op.requestBody ? deref(op.requestBody) : null;
      const json = rb?.content?.['application/json'];
      const schema = json?.schema ? deref(json.schema) : null;
      ops.push({
        key: `${m.toUpperCase()} ${p}`,
        method: m.toUpperCase(),
        path: p,
        segs: segsOf(p),
        service: tagService[op.tags?.[0]] ?? 'unknown',
        tag: op.tags?.[0] ?? '',
        summary: op.summary ?? '',
        pathParams: params.filter((x) => x.in === 'path'),
        query: params.filter((x) => x.in === 'query'),
        headers: params.filter((x) => x.in === 'header'),
        schema,
        example: json?.example ?? schema?.example ?? Object.values(json?.examples ?? {})[0]?.value,
        multipart: Boolean(rb?.content?.['multipart/form-data']),
        admin: p.includes('/admin/'),
      });
    }
  }
  return ops;
}

function classify(o) {
  const last = o.segs.at(-1);
  if (CLASS_OVERRIDES[o.key]) return CLASS_OVERRIDES[o.key];
  if (o.method === 'DELETE') return ['skip', 'DELETE is never run (user rule)'];
  if (o.method === 'GET') return ['read'];
  if (o.multipart) return ['skip', 'file upload (multipart)'];
  if (isParam(last))
    return o.method === 'POST' ? ['skip', 'state action (verb in path)'] : ['update'];
  if (ENABLE && ENABLE_STEPS.includes(last)) return ['enable'];
  if (o.method === 'POST' && READ_POSTS.has(last)) return ['read'];
  if (ENABLE && ENABLE_STEPS.includes(last) && o.method !== 'GET') return ['enable'];
  if (last === 'approve')
    return [
      'skip',
      ENABLE
        ? 'approval needs a second admin: set APPROVER_EMAIL / APPROVER_PASSWORD (a real second admin) in .env'
        : 'state action "approve"',
    ];
  if (ACTION_WORDS.has(last)) return ['skip', `state action "${last}"`];
  if (o.method === 'POST') return ['create'];
  return ['update'];
}

/** Resource noun of a path: last non-param segment (create/list) — e.g. …/warehouses → warehouse. */
function nounOf(o) {
  const segs = o.segs.filter((s) => !isParam(s));
  return norm(singular(segs.at(-1) ?? 'record'));
}
/** Noun behind a path param: `{batchId}` → batch, `…/zones/{id}` → zone. */
function paramNoun(segs, idx) {
  return paramNouns(segs, idx)[0];
}
/** Every plausible noun for a path param: `…/customers/{userId}` → [user, customer]. */
function paramNouns(segs, idx) {
  const name = segs[idx].slice(1, -1);
  const out = [];
  if (/Id$/.test(name) && name !== 'id') out.push(norm(singular(name.replace(/Id$/, ''))));
  for (let k = idx - 1; k >= 0; k--)
    if (!isParam(segs[k])) {
      out.push(norm(singular(segs[k])));
      break;
    }
  if (!out.length) out.push(norm(name));
  return [...new Set(out)];
}

/** Fill path params. testOnly → only records this run created. Returns null if one is missing. */
function fillPath(o, ctx, { testOnly }) {
  const used = [];
  const paramIdx = o.segs.map((s2, k) => (isParam(s2) ? k : -1)).filter((k) => k >= 0);
  const preset = {};
  if (paramIdx.length > 1) {
    // e.g. /products/{id}/variants/{variantId}: a variant of THAT product, not any product + any variant
    const lastIdx = paramIdx.at(-1);
    const pctx0 = { ...ctx, path: o.path };
    const kids = candidates(findBucket(paramNouns(o.segs, lastIdx)[0]), pctx0, testOnly).filter(
      (r) => r.parentIds?.length === paramIdx.length - 1,
    );
    const kid = kids.length ? kids[((ctx.i ?? 1) - 1) % kids.length] : null;
    if (kid) {
      preset[lastIdx] = kid.id;
      paramIdx.slice(0, -1).forEach((k, n) => (preset[k] = kid.parentIds[n].id));
    }
  }
  const segs = o.segs.map((seg, idx) => {
    if (!isParam(seg)) return seg;
    if (preset[idx] !== undefined) {
      used.push({ noun: paramNoun(o.segs, idx), id: preset[idx] });
      return encodeURIComponent(preset[idx]);
    }
    const nouns = paramNouns(o.segs, idx);
    const noun = nouns[0];
    const name = seg.slice(1, -1);
    const pctx = { ...ctx, path: o.path };
    let val = null;
    const j = (ctx.i ?? 1) - 1;
    for (const n of nouns) {
      if (/id$/i.test(name)) val = pickId(n, pctx, { testOnly });
      else {
        const pool = candidates(findBucket(n), pctx, testOnly).map((r) => r.data ?? r.body);
        const withField = pool.filter((x) => x && x[name] != null);
        val = withField.length ? withField[j % withField.length][name] : null;
      }
      if (val != null) break;
    }
    if (val == null) {
      used.push({ noun, missing: true });
      return null;
    }
    used.push({ noun, id: val });
    return encodeURIComponent(val);
  });
  if (segs.includes(null))
    return { url: null, missing: used.filter((u) => u.missing).map((u) => u.noun) };
  return { url: '/' + segs.join('/'), ids: used };
}

function queryString(o, ctx, extra = {}, { allFk = false } = {}) {
  const q = new URLSearchParams();
  for (const p of o.query) {
    if (extra[p.name] !== undefined) continue;
    if (!p.required && !(allFk && /Id$/.test(p.name))) continue;
    const v = build(p.schema ?? { type: 'string' }, ctx, p.name);
    if (v !== undefined && v !== null) q.set(p.name, Array.isArray(v) ? v[0] : v);
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

function writeHeaders(o, etag) {
  const h = { 'idempotency-key': randomUUID() };
  if (etag) h['if-match'] = etag;
  return h;
}

const extractId = (d) => {
  if (!d || typeof d !== 'object') return null;
  if (typeof d.id === 'string') return d.id;
  for (const v of Object.values(d))
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.id === 'string') return v.id;
  return null;
};
const listOf = (json) => {
  const d = json?.data;
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object')
    for (const v of Object.values(d))
      if (Array.isArray(v) && (!v[0] || typeof v[0] === 'object')) return v;
  return null;
};

// ─── Result bookkeeping ───────────────────────────────────────────────────────────────────────
function ep(o) {
  if (!endpoints.has(o.key))
    endpoints.set(o.key, {
      method: o.method,
      path: o.path,
      service: o.service,
      tag: o.tag,
      kind: o.kind,
      skipReason: o.skipReason ?? null,
      calls: [],
      negatives: [],
      created: 0,
      note: null,
    });
  return endpoints.get(o.key);
}
function record(o, phase, url, r, ok, extra = {}) {
  const err = r.json?.error;
  ep(o).calls.push({
    phase,
    url,
    status: r.status,
    ms: r.ms,
    ok,
    error: ok
      ? undefined
      : err
        ? `${err.code}: ${err.message}${err.details?.issues ? ' ' + short(err.details.issues, 400) : ''}`
        : (r.error ?? r.text),
    ...(ok || !r.trail ? {} : { trail: r.trail }),
    ...extra,
  });
}
const ok2xx = (r) => r.status >= 200 && r.status < 300;

// ─── DB verification ──────────────────────────────────────────────────────────────────────────
async function initDb() {
  if (!process.env.DATABASE_URL) return console.warn('  DATABASE_URL not set: DB checks off');
  try {
    const adapter = fs.realpathSync(
      path.join(ROOT, 'packages/database/node_modules/@prisma/adapter-pg/package.json'),
    );
    const pg = createRequire(adapter)('pg');
    const raw = process.env.DATABASE_URL;
    const u = new URL(raw);
    const ssl = /^(require|verify-ca|verify-full|prefer)$/.test(
      u.searchParams.get('sslmode') ?? '',
    );
    u.searchParams.delete('sslmode');
    u.searchParams.delete('channel_binding');
    pgPool = new pg.Pool({
      connectionString: u.toString(),
      max: 4,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
    });
    const r = await pgPool.query(
      `SELECT table_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'id' AND data_type IN ('uuid','text','character varying')`,
    );
    for (const row of r.rows)
      (row.data_type === 'uuid' ? idTables.uuid : idTables.text).push(row.table_name);
    console.log(`  DB: ${idTables.uuid.length + idTables.text.length} tables with an id column`);
    // migrations in the repo that this DB has not applied → their APIs fail with 500 (missing tables)
    const local = fs
      .readdirSync(path.join(ROOT, 'packages/database/prisma/migrations'))
      .filter((d) => /^d/.test(d));
    const done = await pgPool.query(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    const applied = new Set(done.rows.map((x) => x.migration_name));
    dbChecks.pendingMigrations = local.filter((d) => !applied.has(d));
    if (dbChecks.pendingMigrations.length)
      console.log(
        `  DB is missing ${dbChecks.pendingMigrations.length} migrations: ${dbChecks.pendingMigrations.join(', ')}`,
      );
  } catch (e) {
    console.warn(`  DB connect failed (${e.message}): DB checks off`);
    pgPool = null;
  }
}

/** Find the table of each new test id with ONE union query. */
async function verifyCreated(recs) {
  if (!pgPool || !recs.length) return;
  const ids = recs.map((r) => r.id);
  const uuidIds = ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  const parts = [
    ...idTables.uuid.map(
      (t) => `SELECT '${t}' AS t, id::text AS id FROM "${t}" WHERE id = ANY($1::uuid[])`,
    ),
    ...idTables.text.map(
      (t) => `SELECT '${t}' AS t, id::text AS id FROM "${t}" WHERE id = ANY($2::text[])`,
    ),
  ];
  try {
    const res = await pgPool.query(parts.join(' UNION ALL '), [uuidIds, ids]);
    const found = new Map(res.rows.map((row) => [row.id, row.t]));
    for (const r of recs) {
      r.table = found.get(r.id) ?? null;
      if (r.table) dbChecks.verified++;
      else dbChecks.missing.push({ id: r.id, endpoint: r.op });
    }
  } catch (e) {
    console.warn(`  DB verify failed: ${e.message}`);
  }
}

const sameValue = (sent, got) => {
  if (got === null || got === undefined) return sent === null || sent === undefined;
  if (got instanceof Date) {
    const s = new Date(sent);
    // DATE columns come back as local midnight (IST), so compare the local calendar day too
    const local = `${got.getFullYear()}-${String(got.getMonth() + 1).padStart(2, '0')}-${String(got.getDate()).padStart(2, '0')}`;
    const sentDay = String(sent).slice(0, 10);
    const sentLocal = Number.isNaN(s.getTime())
      ? sentDay
      : `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
    return (
      !Number.isNaN(s.getTime()) &&
      (Math.abs(s.getTime() - got.getTime()) < 1000 ||
        sentDay === got.toISOString().slice(0, 10) ||
        sentDay === local ||
        sentLocal === local)
    );
  }
  if (typeof sent === 'number' || /^-?\d+(\.\d+)?$/.test(String(got)))
    return Number(sent) === Number(got);
  if (typeof sent === 'boolean') return sent === got || String(sent) === String(got);
  if (typeof sent === 'string' && typeof got === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(sent) && /^\d{4}-\d{2}-\d{2}/.test(got))
      return sent.slice(0, 10) === got.slice(0, 10);
    return sent.trim().toLowerCase() === got.trim().toLowerCase();
  }
  return true; // objects / arrays: not compared column-wise
};

async function verifyRow(table, id, body) {
  if (!pgPool || !table) return { checked: 0, bad: [] };
  const r = await pgPool.query(`SELECT * FROM "${table}" WHERE id = $1`, [id]);
  const row = r.rows[0];
  if (!row) return { checked: 0, bad: ['row not found'] };
  const bad = [];
  let checked = 0;
  for (const [k, v] of Object.entries(body)) {
    if (v === null || typeof v === 'object' || !(k in row)) continue;
    checked++;
    if (!sameValue(v, row[k])) bad.push(`${k}: sent ${short(v, 60)} / db ${short(row[k], 60)}`);
  }
  return { checked, bad };
}

// ─── Optimistic concurrency: expectedVersion / version from the live record ──────────────────
const versionKey = (o) =>
  Object.keys(deref(o.schema ?? {}).properties ?? {}).find(
    (k) => /^(expected)?version$|[a-z]Version$/i.test(k) && !/api|schema|doc|template/i.test(k),
  );
const pickVersion = (d) => {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return undefined;
  const k = Object.keys(d).find((x) => /version$/i.test(x) && typeof d[x] === 'number');
  return k ? d[k] : undefined;
};
const usesIfMatch = (o) => (o.headers ?? []).some((h) => /^if-match$/i.test(h.name));
/** Current version of a record: GET same path → the test record → GET parent path. */
async function liveVersion(url, rec) {
  const clean = url.split('?')[0];
  let v;
  const g = await adminHttp('GET', clean);
  if (ok2xx(g)) v = pickVersion(g.json?.data);
  // the live parent beats the record's create-time copy (other writes may have bumped it)
  if (v === undefined) {
    const g2 = await adminHttp('GET', clean.split('/').slice(0, -1).join('/'));
    if (ok2xx(g2)) v = pickVersion(g2.json?.data);
  }
  if (v === undefined && rec) v = pickVersion(rec.data);
  return v;
}
/** Sets the body's version field from: GET same path → the test record → GET parent path. */
async function fillVersion(o, url, body, rec) {
  const vk = versionKey(o);
  if (!vk || !body || typeof body !== 'object') return;
  const clean = url.split('?')[0];
  let v;
  const g = await adminHttp('GET', clean);
  if (ok2xx(g)) v = pickVersion(g.json?.data);
  if (v === undefined && rec) v = pickVersion(rec.data);
  if (v === undefined) {
    const g2 = await adminHttp('GET', clean.split('/').slice(0, -1).join('/'));
    if (ok2xx(g2)) v = pickVersion(g2.json?.data);
  }
  if (v !== undefined) body[vk] = v;
}

// ─── Core: send a write with 422 repair ───────────────────────────────────────────────────────
const memos = new Map();
async function sendWrite(o, url, body, ctx, { token, etag: etagIn, rec } = {}) {
  let etag = etagIn;
  if (!etag && usesIfMatch(o)) {
    const v = await liveVersion(url, rec);
    if (v !== undefined) etag = String(v);
  }
  if (!memos.has(o.key)) memos.set(o.key, { drop: new Set(), force: new Map() });
  const memo = memos.get(o.key);
  applyMemo(body, memo);
  let r;
  // fallbacks when repair can't help: 'safe' = example-consistent enums; 'minimal' = required + example keys
  const stages = [{ minimal: true }, { safe: true }, { safe: true, minimal: true }];
  const trail = [];
  for (let attempt = 0; attempt < 9; attempt++) {
    const headers = writeHeaders(o, etag);
    r = token
      ? await http(o.method, url, { token, body, headers })
      : await adminHttp(o.method, url, { body, headers });
    if (!ok2xx(r))
      trail.push(
        `${r.status} ${r.json?.error?.message ?? ''} ${short(r.json?.error?.details?.issues ?? '', 160) ?? ''}`.trim(),
      );
    if (r.status === 409 && attempt === 0 && ctx.kind === 'create') {
      const fresh = build(o.schema, { ...ctx, i: ctx.i + 10 }, '', 0, o.example);
      for (const k of Object.keys(body))
        if (
          /name|title|code|sku|slug|email|phone|key|number|label/i.test(k) &&
          fresh[k] !== undefined
        )
          body[k] = fresh[k];
      continue;
    }
    // stale version ("changed by someone else; reload") → reload the version once and retry
    if (
      r.status === 409 &&
      (ctx.reloaded ?? 0) < 3 &&
      (versionKey(o) || usesIfMatch(o)) &&
      /changed|reload|version/i.test(r.json?.error?.message ?? '')
    ) {
      ctx.reloaded = (ctx.reloaded ?? 0) + 1;
      await sleep(300 * ctx.reloaded); // another write on the same record may be in flight
      if (versionKey(o)) await fillVersion(o, url, body, rec);
      if (usesIfMatch(o)) {
        const v = await liveVersion(url, rec);
        if (v !== undefined) etag = String(v);
      }
      continue;
    }
    if (r.status !== 422 && r.status !== 400) break;
    const issues = r.json?.error?.details?.issues ?? [];
    if (r.status === 422 && repair(body, issues, o, ctx, memo)) continue;
    const stage = stages.shift();
    if (!stage || !o.schema) break;
    const next = build(o.schema, { ...ctx, ...stage }, '', 0, o.example);
    applyMemo(next, memo);
    for (const k of Object.keys(body)) Reflect.deleteProperty(body, k);
    Object.assign(body, next);
  }
  if (!ok2xx(r) && trail.length > 1) r.trail = trail;
  return r;
}

// ─── Passes ───────────────────────────────────────────────────────────────────────────────────
async function passLists(ops) {
  const lists = ops.filter(
    (o) =>
      o.kind === 'read' &&
      o.method === 'GET' &&
      !o.pathParams.length &&
      !o.query.some((q) => q.required),
  );
  await pool(lists, 6, async (o) => {
    // the biggest page the API allows: more real records to reference (e.g. the live layout to clone)
    const url = o.query.some((q) => q.name === 'limit') ? `${o.path}?limit=100` : o.path;
    const r = await adminHttp('GET', url);
    const ok = ok2xx(r);
    record(o, 'A list', url, r, ok);
    if (ok) {
      const d = r.json?.data;
      let items = listOf(r.json);
      if (!items && d && typeof d === 'object' && !Array.isArray(d))
        // a single record, or a key → value settings map (rows for `…/settings/{key}`)
        items = d.id ? [d] : Object.entries(d).map(([k, v]) => ({ id: k, key: k, value: v }));
      for (const it of items ?? []) addSeen(nounOf(o), it, o.path);
      o.listItems = (items ?? []).length;
    }
  });
  return lists.length;
}

async function customerSetup(ops) {
  if (!tokens.customers.length) return;
  const byPath = new Map(ops.map((o) => [o.key, o]));
  for (const [p, noun] of CUSTOMER_LISTS) {
    if (!inScope(byPath.get(`GET ${p}`) ?? { path: p, service: '?' })) continue;
    for (const c of tokens.customers) {
      const r = await http('GET', p, { token: c.token });
      for (const it of listOf(r.json) ?? [])
        if (it?.id)
          addTest(noun, { id: it.id, noun, op: `GET ${p}`, data: it, body: {}, i: 1, owner: c.id });
    }
  }
  for (const [p, noun] of CUSTOMER_CREATES) {
    const o = byPath.get(`POST ${p}`);
    if (!o || !inScope(o)) continue;
    const created = [];
    for (let n = 0; n < tokens.customers.length; n++) {
      const c = tokens.customers[n];
      const ctx = { i: n + 1, noun, path: p, kind: 'create', round: 2, unresolved: new Set() };
      const body = build(o.schema, ctx, '', 0, o.example);
      const r = await sendWrite(o, p, body, ctx, { token: c.token });
      const id = extractId(r.json?.data);
      const rec = { id, noun, op: o.key, data: r.json?.data, body, i: n + 1, owner: c.id };
      if (ok2xx(r) && id) {
        addTest(noun, rec);
        created.push(rec);
      }
      o.customerResults = [
        ...(o.customerResults ?? []),
        { phone: c.phone, status: r.status, error: r.json?.error?.message },
      ];
    }
    await verifyCreated(created);
  }
}

async function passCreates(ops) {
  const creates = ops
    .filter((o) => o.kind === 'create')
    .sort((a, b) => a.pathParams.length - b.pathParams.length || fkCount(a) - fkCount(b));
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let progress = 0;
    const roundRecs = [];
    await pool(
      creates.filter((o) => ep(o).created < PER),
      CONCURRENCY,
      async (o) => {
        const e = ep(o);
        e.attempts ??= 0;
        let failures = 0;
        // every attempt is a fresh variant (enum choice, unique values); 3 failures end the op's round
        while (e.created < PER && failures < 3 && e.attempts < PER * 4) {
          const i = ++e.attempts;
          const ctx = {
            i,
            noun: nounOf(o),
            path: o.path,
            kind: 'create',
            round,
            unresolved: new Set(),
          };
          const filled = fillPath(o, ctx, { testOnly: true });
          if (!filled.url) {
            e.attempts--;
            e.note = `needs a TEST-owned ${filled.missing.join(', ')} (no test parent created)`;
            return;
          }
          const body = o.schema ? build(o.schema, ctx, '', 0, o.example) : undefined;
          const url = filled.url + queryString(o, ctx);
          const parentId = filled.ids?.at(-1)?.id;
          const parentRec = parentId
            ? findBucket(filled.ids.at(-1).noun)?.test.find((t) => t.id === parentId)
            : undefined;
          if (body) await fillVersion(o, filled.url, body, parentRec);
          const r =
            body === undefined
              ? await adminHttp('POST', url, { headers: writeHeaders(o) })
              : await sendWrite(o, url, body, ctx, { rec: parentRec });
          const ok = ok2xx(r);
          let id = extractId(r.json?.data);
          let data = r.json?.data;
          // POST /products/{id}/variants answers with the product: find the new child inside it
          if (ok && id && id === parentId && data && typeof data === 'object') {
            const arr =
              Object.entries(data).find(
                ([k, v]) => Array.isArray(v) && norm(singular(k)) === nounOf(o),
              )?.[1] ?? [];
            const known = new Set((findBucket(nounOf(o))?.test ?? []).map((t) => t.id));
            const fresh = arr.filter((x) => x?.id && !known.has(x.id));
            const match =
              fresh.find((x) =>
                Object.entries(body ?? {}).some(([k, v]) => typeof v === 'string' && x[k] === v),
              ) ?? fresh.at(-1);
            id = match?.id ?? null;
            data = match ?? data;
          }
          record(
            o,
            `B create r${round}`,
            url,
            r,
            ok,
            ok ? { id } : { body: short(body, 600), unresolvedFk: [...ctx.unresolved] },
          );
          if (!ok) {
            e.note = ctx.unresolved.size
              ? `no record for FK: ${[...ctx.unresolved].join(', ')}`
              : null;
            failures++;
            // missing dependencies / server errors won't change within this round
            if (r.status >= 500 || r.status === 404 || r.status === 0) return;
            continue;
          }
          e.created++;
          progress++;
          e.note = null;
          if (id) {
            const rec = { id, noun: ctx.noun, op: o.key, data, body, i, parentIds: filled.ids };
            addTest(ctx.noun, rec);
            roundRecs.push(rec);
            // children created inline (product.variants[] …) belong to this run too
            if (data && typeof data === 'object')
              for (const [k, v] of Object.entries(data))
                if (
                  Array.isArray(v) &&
                  v[0] &&
                  typeof v[0] === 'object' &&
                  v[0].id &&
                  norm(singular(k)) !== ctx.noun
                )
                  for (const x of v) {
                    const kid = {
                      id: x.id,
                      noun: norm(singular(k)),
                      op: o.key,
                      data: x,
                      body: {},
                      i,
                      parentIds: [...(filled.ids ?? []), { noun: ctx.noun, id }],
                    };
                    addTest(kid.noun, kid);
                    roundRecs.push(kid);
                  }
          }
        }
      },
    );
    await verifyCreated(roundRecs);
    const left = creates.filter((o) => ep(o).created < PER).length;
    console.log(`  round ${round}: +${progress} records, ${left} create APIs still under ${PER}`);
    if (!progress || !left) break;
  }
}
const fkCount = (o) => JSON.stringify(o.schema ?? {}).split('"format":"uuid"').length - 1;

async function passGets(ops) {
  // lists that failed bare in pass A (400/404/422) are retried with their optional …Id filters filled
  const retryList = (o) =>
    [400, 404, 422].includes(ep(o).calls.find((c) => c.phase === 'A list')?.status);
  const gets = ops.filter(
    (o) =>
      o.kind === 'read' &&
      (o.pathParams.length ||
        o.query.some((q) => q.required) ||
        o.method === 'POST' ||
        retryList(o)),
  );
  await pool(gets, 6, async (o) => {
    const e = ep(o);
    const allFk = retryList(o);
    if (allFk) e.calls = e.calls.filter((c) => c.phase !== 'A list');
    const lastIsParam = isParam(o.segs.at(-1));
    const noun = o.pathParams.length ? paramNoun(o.segs, o.segs.findLastIndex(isParam)) : nounOf(o);
    const tests = findBucket(noun)?.test ?? [];
    const n = o.method === 'GET' && lastIsParam && tests.length ? Math.min(PER, tests.length) : 1;
    let tried = 0;
    for (let i = 1; i <= n; i++) {
      const ctx = { i, noun, path: o.path, kind: 'read', round: 9 };
      let filled = fillPath(o, ctx, { testOnly: true });
      if (!filled.url) filled = fillPath(o, ctx, { testOnly: false });
      if (!filled.url) {
        e.note = `no record id available for ${filled.missing.join(', ')}`;
        continue;
      }
      const url = filled.url + queryString(o, ctx, {}, { allFk });
      tried++;
      const r =
        o.method === 'POST'
          ? await sendWrite(
              o,
              url,
              build(o.schema ?? { type: 'object' }, { ...ctx, kind: 'create' }, '', 0, o.example),
              ctx,
            )
          : await adminHttp('GET', url);
      const ok = ok2xx(r);
      record(o, 'C get', url, r, ok);
      // compare with what was sent when this is GET-by-id of a test record
      if (ok && o.method === 'GET' && lastIsParam) {
        const id = filled.ids.at(-1)?.id;
        const rec = tests.find((t) => t.id === id);
        const d = r.json?.data;
        if (rec?.body && d && typeof d === 'object')
          for (const [k, v] of Object.entries(rec.body))
            if (v !== null && typeof v !== 'object' && k in d && !sameValue(v, d[k]))
              mismatches.push({ endpoint: o.key, id, field: k, sent: v, got: d[k] });
      }
    }
    if (!tried && !e.note) e.note = 'no record id available';
  });
}

async function passListChecks(ops) {
  const lists = ops.filter(
    (o) =>
      o.kind === 'read' &&
      o.method === 'GET' &&
      !o.pathParams.length &&
      !o.query.some((q) => q.required) &&
      ep(o).calls.find((c) => c.phase === 'A list')?.ok === true,
  );
  await pool(lists, 6, async (o) => {
    const names = new Set(o.query.map((q) => q.name));
    const noun = nounOf(o);
    const tests = findBucket(noun)?.test ?? [];
    if (names.has('limit')) {
      const r1 = await adminHttp('GET', `${o.path}?limit=2`);
      const items1 = listOf(r1.json) ?? [];
      const next = r1.json?.meta?.nextCursor;
      let ok = ok2xx(r1) && items1.length <= 2;
      let note = `page1 ${items1.length} rows`;
      if (ok && next && names.has('cursor')) {
        const r2 = await adminHttp('GET', `${o.path}?limit=2&cursor=${encodeURIComponent(next)}`);
        const ids1 = new Set(items1.map((x) => x?.id));
        const items2 = listOf(r2.json) ?? [];
        ok = ok2xx(r2) && !items2.some((x) => x?.id && ids1.has(x.id));
        note += `, page2 ${items2.length} rows, overlap=${!ok}`;
      }
      record(o, 'D pagination', `${o.path}?limit=2`, r1, ok, { note });
      const r3 = await adminHttp('GET', `${o.path}?limit=101`);
      record(
        o,
        'D limit>100',
        `${o.path}?limit=101`,
        r3,
        r3.status === 422 ||
          r3.status === 400 ||
          (ok2xx(r3) && (listOf(r3.json) ?? []).length <= 100),
        { note: 'expect 422 or capped at 100' },
      );
    }
    const searchParam = ['search', 'q', 'query'].find((n) => names.has(n));
    if (searchParam) {
      const r = await adminHttp('GET', `${o.path}?${searchParam}=${encodeURIComponent(TAG)}`);
      const items = listOf(r.json) ?? [];
      const ok = ok2xx(r);
      record(o, 'D search', `${o.path}?${searchParam}=${TAG}`, r, ok, {
        note: `${items.length} rows${tests.length && !items.length ? ' (expected TEST rows)' : ''}`,
      });
    }
    for (const q of o.query) {
      const s = deref(q.schema ?? {});
      const en = s.enum ?? deref(s.items ?? {}).enum;
      if (!en?.length || ['limit', 'cursor'].includes(q.name)) continue;
      const isSort = /sort|order/i.test(q.name);
      const val = en[0];
      const url = `${o.path}?${q.name}=${encodeURIComponent(val)}`;
      const r = await adminHttp('GET', url);
      const items = listOf(r.json) ?? [];
      const wrong = isSort ? [] : items.filter((x) => x && q.name in x && x[q.name] !== val);
      record(o, isSort ? 'D sort' : 'D filter', url, r, ok2xx(r) && !wrong.length, {
        note: `${items.length} rows${wrong.length ? `, ${wrong.length} not matching` : ''}`,
      });
    }
  });
}

/** Config nouns whose existing rows may get an unchanged write-back (never new values). */
const CONFIG_NOUN = /setting|registry|pincode|slapolicy|sla|threshold|config|fallback|cutoff/;

/** PUT/PATCH the current value back: proves the write path without changing real config. */
async function writeBackSame(o, e, url, root, etag, label) {
  const props = Object.keys(deref(o.schema ?? {}).properties ?? {});
  // the settings object may be wrapped (data.settings, data.values…): take the best key overlap
  const shapes = [
    root,
    ...Object.values(root ?? {}).filter((v) => v && typeof v === 'object' && !Array.isArray(v)),
  ];
  const overlap = (d) => props.filter((k) => d[k] !== undefined && d[k] !== null).length;
  const data = shapes.sort((a, b) => overlap(b) - overlap(a))[0] ?? {};
  const body = Object.fromEntries(
    props.filter((k) => data[k] !== undefined && data[k] !== null).map((k) => [k, data[k]]),
  );
  // audit-only fields (reason / note) may be filled; any other missing field would change config
  const audit = /reason|note|comment|remark/i;
  for (const k of deref(o.schema ?? {}).required ?? [])
    if (body[k] === undefined && audit.test(k))
      body[k] = `${TAG} config check run ${RUN}: values written back unchanged.`;
  const missing = (deref(o.schema ?? {}).required ?? []).filter((k) => body[k] === undefined);
  if (!Object.keys(body).filter((k) => !audit.test(k)).length || missing.length) {
    e.note = `config: current value does not match the ${o.method} body${missing.length ? ` (missing ${missing.join(', ')})` : ''}; not changed`;
    return;
  }
  // no 422 repair / fallback bodies here: those could change config
  const r = await adminHttp(o.method, url, { body, headers: writeHeaders(o, etag) });
  record(o, 'E update (same value)', url, r, ok2xx(r), {
    note: label,
    ...(ok2xx(r) ? {} : { body: short(body, 400) }),
  });
}

async function passUpdates(ops) {
  const updates = ops.filter((o) => o.kind === 'update');
  const byKey = new Map(ops.map((o) => [o.key, o]));
  await pool(updates, CONCURRENCY, async (o) => {
    const e = ep(o);
    const getOp = byKey.get(`GET ${o.path}`);
    if (!o.pathParams.length) {
      // global config: write the current value back unchanged
      if (!getOp) {
        e.note = 'global config without a GET to read the current value (not changed)';
        return;
      }
      const cur = await adminHttp('GET', o.path);
      if (!ok2xx(cur)) {
        e.note = `GET current value failed (${cur.status})`;
        return;
      }
      await writeBackSame(
        o,
        e,
        o.path,
        cur.json?.data ?? {},
        cur.etag,
        'global config written back unchanged',
      );
      return;
    }
    const lastIdx = o.segs.findLastIndex(isParam);
    const noun = paramNoun(o.segs, lastIdx);
    const tests = findBucket(noun)?.test ?? [];
    const n = Math.min(PER, Math.max(tests.length, 1));
    let tried = 0;
    for (let i = 1; i <= n; i++) {
      const ctx = {
        i,
        noun,
        path: o.path,
        kind: 'update',
        update: true,
        round: 9,
        unresolved: new Set(),
      };
      const filled = fillPath(o, ctx, { testOnly: true });
      if (!filled.url) {
        e.note = `only TEST records are updated; none for ${filled.missing.join(', ')}`;
        const seen = CONFIG_NOUN.test(noun) ? fillPath(o, ctx, { testOnly: false }) : null;
        if (seen?.url) {
          // existing config row (setting / registry / pincode / SLA…): write its current value back unchanged
          let root = null;
          let etag;
          if (getOp) {
            const g = await adminHttp('GET', seen.url);
            if (ok2xx(g)) [root, etag] = [g.json?.data, g.etag ?? undefined];
          }
          if (!root) {
            const val = decodeURIComponent(seen.url.split('/').at(-1));
            const pool = candidates(findBucket(noun), ctx, false).map(
              (r) => r.data ?? r.body ?? {},
            );
            root = pool.find((x) => Object.values(x).some((v) => String(v) === val)) ?? null;
          }
          if (root) {
            e.note = null;
            await writeBackSame(
              o,
              e,
              seen.url,
              root,
              etag,
              'existing config row written back unchanged',
            );
          }
        }
        break;
      }
      tried++;
      let etag;
      let current;
      if (getOp) {
        const g = await adminHttp('GET', filled.url);
        etag = g.etag ?? undefined;
        current = g.json?.data;
      }
      const body = o.schema ? build(o.schema, { ...ctx, i: i + 5 }, '', 0, o.example) : undefined;
      const lastId = filled.ids.at(-1)?.id;
      const target = tests.find((t) => t.id === lastId);
      if (body && versionKey(o)) await fillVersion(o, filled.url, body, target);
      if (body && current && typeof current === 'object') {
        const props = deref(o.schema).properties ?? {};
        if ('version' in props && current.version !== undefined) body.version = current.version;
      }
      const url = filled.url + queryString(o, ctx);
      let r =
        body === undefined
          ? await adminHttp(o.method, url, { headers: writeHeaders(o, etag) })
          : await sendWrite(o, url, body, ctx, { etag, rec: target });
      // complex nested bodies (layouts, rules): fall back to the record's own current state with
      // its name / title changed — a real edit that keeps every nested rule valid
      const base = current && typeof current === 'object' ? current : target?.data;
      if (body && [400, 422].includes(r.status) && base && typeof base === 'object') {
        const props = deref(o.schema).properties ?? {};
        const edit = Object.fromEntries(
          Object.keys(props)
            .filter((k) => base[k] !== undefined && base[k] !== null)
            .map((k) => [k, structuredClone(base[k])]),
        );
        for (const k of Object.keys(edit))
          if (/^(name|title|label|displayName)$/.test(k) && typeof edit[k] === 'string')
            edit[k] = `${TAG} ${human(noun)} ${i} ${RUN} (edited)`.slice(
              0,
              deref(props[k]).maxLength ?? 200,
            );
        for (const k of deref(o.schema).required ?? [])
          if (edit[k] === undefined && body[k] !== undefined) edit[k] = body[k];
        if (versionKey(o)) await fillVersion(o, filled.url, edit, target);
        const r2 = await sendWrite(o, url, edit, { ...ctx, safe: true }, { etag, rec: target });
        if (ok2xx(r2)) {
          r = r2;
          for (const k of Object.keys(body)) Reflect.deleteProperty(body, k);
          Object.assign(body, edit);
        }
      }
      let ok = ok2xx(r);
      // keep the record's live state (version etc.) for the next update of the same row
      if (
        ok &&
        target &&
        r.json?.data &&
        typeof r.json.data === 'object' &&
        r.json.data.id === target.id
      )
        target.data = r.json.data;
      let note;
      if (ok && body && isParam(o.segs.at(-1))) {
        const id = filled.ids.at(-1)?.id;
        const rec = tests.find((t) => t.id === id);
        if (rec?.table) {
          const v = await verifyRow(rec.table, id, body);
          note = `DB ${rec.table}: ${v.checked} fields checked${v.bad.length ? `, MISMATCH ${v.bad.join('; ')}` : ''}`;
          if (v.bad.length) ok = false;
          else dbChecks.verified++;
        }
      }
      record(o, 'E update', url, r, ok, { note, ...(ok ? {} : { body: short(body, 600) }) });
    }
    if (!tried && !e.note) e.note = 'no TEST record to update';
  });
}

/** Logs in the second admin from .env (APPROVER_EMAIL / APPROVER_PASSWORD) for the approve step. */
async function approverLogin() {
  const r = await http('POST', '/v1/auth/auth/admin/login', {
    body: { identifier: process.env.APPROVER_EMAIL, password: process.env.APPROVER_PASSWORD },
  });
  const d = r.json?.data;
  if (d?.status === 'mfa_required')
    return console.warn('  approver login needs MFA: approve step skipped');
  if (!d?.accessToken)
    return console.warn(
      `  approver login failed (${r.status} ${short(r.json?.error?.message)}): approve step skipped`,
    );
  tokens.approver = d.accessToken;
  const id = decodeJwt(d.accessToken).sub;
  if (id && id === tokens.adminId) {
    tokens.approver = null;
    console.warn(
      '  APPROVER_EMAIL is the same admin as SEED_ADMIN_EMAIL: approve step skipped (approver ≠ submitter)',
    );
  }
}

/**
 * Approve step: TEST-AUTO records waiting for review — this run's and earlier runs' (seen in the
 * list) — approved by the second admin. Each record's live status is checked first.
 */
async function approveAll(o, e, noun, tests) {
  if (!tokens.approver) {
    e.note = 'approver login not available (APPROVER_EMAIL / APPROVER_PASSWORD)';
    return;
  }
  const tagged = (findBucket(noun)?.seen ?? [])
    .filter((r) => String(r.data?.name ?? r.data?.title ?? '').startsWith(TAG))
    .map((r) => r.id);
  const ids = [...new Set([...tests.map((t) => t.id), ...tagged])];
  let pending = 0;
  for (const id of ids) {
    const url = o.path.replace(/\{[^}]+\}/, encodeURIComponent(id));
    const cur = await adminHttp('GET', url.split('/').slice(0, -1).join('/'));
    if (!/PENDING|REVIEW|SUBMITTED/.test(cur.json?.data?.status ?? '')) continue;
    pending++;
    const ctx = { i: pending, noun, path: o.path, kind: 'enable', round: 9 };
    const body = o.schema ? build(o.schema, ctx, '', 0, o.example) : undefined;
    const r =
      body === undefined
        ? await http(o.method, url, { token: tokens.approver, headers: writeHeaders(o) })
        : await sendWrite(o, url, body, ctx, { token: tokens.approver });
    record(
      o,
      'F enable approve',
      url,
      r,
      ok2xx(r),
      ok2xx(r) ? { note: `approved by the second admin (was ${cur.json.data.status})` } : {},
    );
  }
  if (!pending) e.note = `no TEST ${noun} waiting for review`;
}

/** --enable: run the enable steps on TEST records (status to ACTIVE, submit, approve, default variant). */
async function passEnable(ops) {
  for (const step of ENABLE_STEPS) {
    const list = ops.filter((o) => o.kind === 'enable' && o.segs.at(-1) === step);
    await pool(list, CONCURRENCY, async (o) => {
      const e = ep(o);
      const lastIdx = o.segs.findLastIndex(isParam);
      const noun = paramNoun(o.segs, lastIdx);
      const tests = findBucket(noun)?.test ?? [];
      if (step === 'approve') {
        await approveAll(o, e, noun, tests);
        return;
      }
      if (!tests.length) {
        e.note = `no TEST ${noun} to enable`;
        return;
      }
      // publish makes ONE record live per page (each publish archives the previous): the last per page
      let picks = tests.slice(0, PER).map((_, n) => n + 1);
      if (step === 'publish') {
        const perPage = new Map();
        tests.forEach((t, n) => perPage.set(t.body?.page ?? t.data?.page ?? 'all', n + 1));
        picks = [...perPage.values()];
      }
      for (const i of picks) {
        const ctx = { i, noun, path: o.path, kind: 'enable', round: 9, unresolved: new Set() };
        const filled = fillPath(o, ctx, { testOnly: true });
        if (step === 'publish') {
          // never publish an empty page: the record must have content (sections / items)
          const g = await adminHttp('GET', filled.url?.split('/').slice(0, -1).join('/') ?? '');
          const d = g.json?.data ?? {};
          const content = Object.values(d).find((v) => Array.isArray(v));
          if (!ok2xx(g) || (content && !content.length)) {
            e.note = 'not published: the TEST record has no content (it would blank the live page)';
            continue;
          }
        }
        if (!filled.url) {
          e.note = `no TEST record for ${filled.missing.join(', ')}`;
          break;
        }
        const body = o.schema ? build(o.schema, ctx, '', 0, o.example) : undefined;
        if (body)
          for (const k of Object.keys(body))
            if (/^is(Active|Enabled|Published|Visible|Live)$/.test(k)) body[k] = true;
        // enable = now: a scheduled* date would only schedule it
        if (body)
          for (const k of Object.keys(body))
            if (/^scheduled/.test(k) && !(deref(o.schema).required ?? []).includes(k))
              Reflect.deleteProperty(body, k);
        const r =
          body === undefined
            ? await adminHttp(o.method, filled.url, { headers: writeHeaders(o) })
            : await sendWrite(o, filled.url, body, ctx);
        record(
          o,
          `F enable ${step}`,
          filled.url,
          r,
          ok2xx(r),
          ok2xx(r) ? {} : { body: short(body, 300) },
        );
      }
    });
  }
}

async function passNegative(ops) {
  const runnable = ops.filter((o) => o.kind !== 'skip');
  const customer = tokens.customers[0]?.token;
  await pool(runnable, 6, async (o) => {
    const e = ep(o);
    const ctx = { i: 1, noun: nounOf(o), path: o.path, kind: o.kind, round: 9 };
    let filled = fillPath(o, ctx, { testOnly: true });
    if (!filled.url) filled = fillPath(o, ctx, { testOnly: false });
    const url =
      (filled.url ?? '/' + o.segs.map((s) => (isParam(s) ? randomUUID() : s)).join('/')) +
      queryString(o, ctx);
    const body =
      o.method === 'GET' ? undefined : o.schema ? build(o.schema, ctx, '', 0, o.example) : {};
    const check = (name, r, expect) =>
      e.negatives.push({ name, status: r.status, expect, ok: expect.includes(r.status) });

    check(
      'no token → 401',
      await http(o.method, url, { body, headers: o.method === 'GET' ? {} : writeHeaders(o) }),
      [401],
    );
    if (customer) {
      const r = await http(o.method, url, {
        token: customer,
        body,
        headers: o.method === 'GET' ? {} : writeHeaders(o),
      });
      check('customer token → 403', r, [403]);
      if (ok2xx(r)) e.securityFlag = 'customer token got 2xx on an admin API';
    }
    if (o.kind === 'create' && (deref(o.schema ?? {}).required ?? []).length) {
      const r = await adminHttp(o.method, filled.url ?? url, {
        body: {},
        headers: writeHeaders(o),
      });
      check('empty body → 422', r, [422]);
    }
    if (o.method === 'GET' && isParam(o.segs.at(-1)) && filled.url) {
      const base = filled.url.split('/').slice(0, -1).join('/');
      const p = deref(o.pathParams.at(-1)?.schema ?? {});
      if (p.format === 'uuid')
        check(
          'malformed id → 400/422',
          await adminHttp('GET', `${base}/not-a-uuid`),
          [400, 404, 422],
        );
      if (p.format === 'uuid' || /id$/i.test(o.pathParams.at(-1)?.name ?? ''))
        check('unknown id → 404', await adminHttp('GET', `${base}/${randomUUID()}`), [404]);
    }
  });
}

// ─── Report ───────────────────────────────────────────────────────────────────────────────────
function finalStatus(e) {
  if (e.kind === 'skip') return 'SKIPPED';
  const main = e.calls.filter((c) => !c.phase.startsWith('D '));
  if (e.kind === 'create')
    return e.created >= PER ? 'PASS' : e.created > 0 ? 'PARTIAL' : main.length ? 'FAIL' : 'NOT RUN';
  if (!main.length) return 'NOT RUN';
  const good = main.filter((c) => c.ok).length;
  const checks = e.calls.filter((c) => c.phase.startsWith('D '));
  if (good === main.length) return checks.every((c) => c.ok) ? 'PASS' : 'PARTIAL';
  return good ? 'PARTIAL' : 'FAIL';
}

function writeReports(startedAt) {
  const dir = path.join(ROOT, 'tests', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const all = [...endpoints.values()].map((e) => ({ ...e, status: finalStatus(e) }));
  const services = [...new Set(all.map((e) => e.service))].sort();
  const count = (list, s) => list.filter((e) => e.status === s).length;
  const lines = [];
  lines.push(`# Swagger admin API automation — run ${RUN}`, '');
  lines.push(
    `- Gateway: ${BASE} · started ${new Date(startedAt).toISOString()} · ${Math.round((Date.now() - startedAt) / 1000)} s`,
  );
  lines.push(
    `- Scope: ${all.length} admin operations (paths with \`/admin/\`). DELETE and state actions are not called (user rule). Creates: ${PER} records each.`,
  );
  lines.push(`- Customers used: ${tokens.customers.map((c) => c.phone).join(', ') || 'none'}`);
  lines.push(
    `- DB (${pgPool ? 'connected' : 'off'}): ${dbChecks.verified} rows verified; ${dbChecks.missing.length} created ids not found by id.`,
  );
  if (dbChecks.pendingMigrations.length)
    lines.push(
      `- **This DB is missing ${dbChecks.pendingMigrations.length} migrations** (their APIs return 500): ${dbChecks.pendingMigrations.map((m) => '`' + m + '`').join(', ')}`,
    );
  lines.push('');
  lines.push(
    '| Service | Ops | Pass | Partial | Fail | Not run | Skipped | Records created |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const s of services) {
    const l = all.filter((e) => e.service === s);
    lines.push(
      `| ${s} | ${l.length} | ${count(l, 'PASS')} | ${count(l, 'PARTIAL')} | ${count(l, 'FAIL')} | ${count(l, 'NOT RUN')} | ${count(l, 'SKIPPED')} | ${l.reduce((n, e) => n + e.created, 0)} |`,
    );
  }
  lines.push(
    `| **Total** | ${all.length} | ${count(all, 'PASS')} | ${count(all, 'PARTIAL')} | ${count(all, 'FAIL')} | ${count(all, 'NOT RUN')} | ${count(all, 'SKIPPED')} | ${all.reduce((n, e) => n + e.created, 0)} |`,
    '',
  );

  const neg = all.flatMap((e) => e.negatives.map((n) => ({ ...n, key: `${e.method} ${e.path}` })));
  const sec = all.filter((e) => e.securityFlag);
  lines.push(`## Negative checks`, '', `${neg.filter((n) => n.ok).length} / ${neg.length} passed.`);
  if (sec.length)
    lines.push(
      '',
      '**SECURITY: customer token accepted on admin APIs:**',
      ...sec.map((e) => `- ${e.method} ${e.path}`),
    );
  const negFail = neg.filter((n) => !n.ok);
  if (negFail.length) {
    lines.push('', '| Endpoint | Check | Got | Expected |', '|---|---|---|---|');
    for (const n of negFail.slice(0, 300))
      lines.push(`| ${n.key} | ${n.name} | ${n.status} | ${n.expect.join('/')} |`);
  }
  lines.push('');

  lines.push(
    '## Records created (test-owned, by table)',
    '',
    '| Noun | Table | Count | Sample ids |',
    '|---|---|---|---|',
  );
  for (const [noun, b] of [...registry].sort()) {
    const recs = b.test.filter((r) => r.op?.startsWith('POST'));
    if (!recs.length) continue;
    const tables = [...new Set(recs.map((r) => r.table ?? '?'))].join(', ');
    lines.push(
      `| ${noun} | ${tables} | ${recs.length} | ${recs
        .slice(0, 2)
        .map((r) => '`' + r.id + '`')
        .join(' ')} |`,
    );
  }
  lines.push('');

  for (const s of services) {
    const l = all.filter((e) => e.service === s && e.status !== 'PASS' && e.status !== 'SKIPPED');
    if (!l.length) continue;
    lines.push(
      `## ${s}: failures and gaps`,
      '',
      '| Status | Endpoint | Kind | Reason |',
      '|---|---|---|---|',
    );
    for (const e of l) {
      const bad = e.calls.filter((c) => !c.ok).at(-1);
      let reason = [
        bad ? `${bad.status} ${bad.error ?? bad.note ?? ''}` : '',
        bad?.trail?.[0] && !String(bad.error).includes(bad.trail[0].slice(4, 40))
          ? `first try: ${bad.trail[0]}`
          : '',
        e.note ?? '',
      ]
        .filter(Boolean)
        .join(' · ');
      if (/P2021|does not exist|relation/i.test(reason))
        reason += ' — table missing on this DB (migration not applied)';
      else if (/^500 /.test(reason) && dbChecks.pendingMigrations.length)
        reason += ' — likely a missing table (see pending migrations above)';
      lines.push(
        `| ${e.status} | ${e.method} ${e.path} | ${e.kind}${e.kind === 'create' ? ` ${e.created}/${PER}` : ''} | ${short(reason, 260).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`,
      );
    }
    lines.push('');
  }
  if (mismatches.length) {
    lines.push(
      '## GET-by-id differences vs sent body',
      '',
      '| Endpoint | Field | Sent | Got |',
      '|---|---|---|---|',
    );
    for (const m of mismatches.slice(0, 150))
      lines.push(`| ${m.endpoint} | ${m.field} | ${short(m.sent, 50)} | ${short(m.got, 50)} |`);
    lines.push('');
  }
  lines.push('## Skipped (not called)', '', '| Endpoint | Reason |', '|---|---|');
  for (const e of all.filter((x) => x.status === 'SKIPPED'))
    lines.push(`| ${e.method} ${e.path} | ${e.skipReason} |`);

  const md = path.join(dir, `admin-api-${stamp}.md`);
  const js = path.join(dir, `admin-api-${stamp}.json`);
  fs.writeFileSync(md, lines.join('\n'));
  fs.writeFileSync(
    js,
    JSON.stringify(
      {
        run: RUN,
        base: BASE,
        startedAt: new Date(startedAt).toISOString(),
        per: PER,
        db: dbChecks,
        records: Object.fromEntries(
          [...registry].map(([k, b]) => [
            k,
            b.test.map((r) => ({ id: r.id, table: r.table, op: r.op })),
          ]),
        ),
        endpoints: all,
        mismatches,
      },
      null,
      1,
    ),
  );
  return { md, js, all, count };
}

// ─── Main ─────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const startedAt = Date.now();
  console.log(`Swagger admin API automation · run ${RUN} · ${BASE}`);
  const res = await http('GET', '/api-docs.json');
  if (!ok2xx(res) || !res.json?.paths)
    throw new Error(`Cannot load ${BASE}/api-docs.json (${res.status})`);
  spec = res.json;
  const all = loadOps();
  for (const o of all) [o.kind, o.skipReason] = classify(o);
  const adminOps = all.filter((o) => o.admin && inScope(o));
  adminOps.forEach(ep);
  const tally = (k) => adminOps.filter((o) => o.kind === k).length;
  console.log(
    `  ${adminOps.length} admin operations: read ${tally('read')} · create ${tally('create')} · update ${tally('update')} · enable ${tally('enable')} · skip ${tally('skip')}`,
  );
  if (DRY) {
    for (const o of adminOps)
      console.log(
        `${o.kind.padEnd(6)} ${o.method.padEnd(6)} ${o.path}${o.skipReason ? `  (${o.skipReason})` : ''}`,
      );
    return;
  }
  await adminLogin();
  console.log(`  admin logged in (${tokens.adminId})`);
  await customerLogins();
  console.log(`  ${tokens.customers.length} test customers logged in`);
  await initDb();
  if (ENABLE || !ONLY || ONLY.includes('media-service')) {
    await uploadImages();
    console.log(`  media-service: ${UPLOADED.length} test images uploaded`);
  }
  if (ENABLE && HAS_APPROVER) {
    await approverLogin();
    console.log(`  second admin (approver): ${tokens.approver ? 'logged in' : 'not available'}`);
  } else if (ENABLE)
    console.log(
      '  approve step off: add APPROVER_EMAIL / APPROVER_PASSWORD (a real second admin) to .env',
    );

  console.log('Pass A: list GETs');
  await passLists(adminOps);
  console.log('Customer setup');
  await customerSetup(all);
  console.log('Pass B: creates');
  await passCreates(adminOps);
  console.log('Pass C: GET by id + parameterised reads');
  await passGets(adminOps);
  console.log('Pass D: pagination / search / filter / sort');
  await passListChecks(adminOps);
  console.log('Pass E: updates (TEST records only)');
  await passUpdates(adminOps);
  if (ENABLE) {
    console.log('Pass F: enable TEST records (status / submit / approve / default)');
    await passEnable(adminOps);
  }
  if (NEGATIVE) {
    console.log('Negative checks');
    await passNegative(adminOps);
  }
  const { md, js, all: rows, count } = writeReports(startedAt);
  console.log(
    `\nDone: ${rows.length} ops · PASS ${count(rows, 'PASS')} · PARTIAL ${count(rows, 'PARTIAL')} · FAIL ${count(rows, 'FAIL')} · NOT RUN ${count(rows, 'NOT RUN')} · SKIPPED ${count(rows, 'SKIPPED')}`,
  );
  console.log(
    `DB rows verified: ${dbChecks.verified} · created ids not found: ${dbChecks.missing.length}`,
  );
  console.log(`Report: ${md}\nJSON:   ${js}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pgPool?.end());
