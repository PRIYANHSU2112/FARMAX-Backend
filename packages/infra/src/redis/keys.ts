/**
 * Redis key builders. Every key is `farmx:<service>:<version>:<parts...>`, e.g.
 * `farmx:auth:v1:user:123`, `farmx:gateway:v1:ratelimit:default:123`.
 *
 * `<version>` is the *cache schema* version of that service's cached data. Bump it when
 * the shape of cached values changes (old entries are then never read and expire by TTL).
 * It is unrelated to npm package versions, and no historical data is kept.
 */
export const KEY_ROOT = 'farmx';

export interface KeyspaceOptions {
  service: string;
  /** Cache schema version, e.g. `v1`. */
  version: string;
}

export interface Keyspace {
  readonly service: string;
  readonly version: string;
  /** `farmx:<service>:<version>` */
  readonly prefix: string;
  /** Builds `prefix:part1:part2...`. Parts must be non-empty and contain no `:`, `*` or whitespace. */
  key: (...parts: (string | number)[]) => string;
}

const SEGMENT = /^[A-Za-z0-9._@+-]+$/;
const assertSegment = (value: string, what: string): void => {
  if (!SEGMENT.test(value)) throw new Error(`Invalid redis key ${what}: "${value}"`);
};

export function createKeyspace(options: KeyspaceOptions): Keyspace {
  assertSegment(options.service, 'service');
  if (!/^v\d+$/.test(options.version)) {
    throw new Error(`Invalid cache version "${options.version}" (expected v1, v2, ...)`);
  }
  const prefix = `${KEY_ROOT}:${options.service}:${options.version}`;
  return {
    service: options.service,
    version: options.version,
    prefix,
    key: (...parts) => {
      if (parts.length === 0) throw new Error('A redis key needs at least one part');
      const segments = parts.map(String);
      for (const segment of segments) assertSegment(segment, 'part');
      return `${prefix}:${segments.join(':')}`;
    },
  };
}

/** Current cache schema versions per service. Bump here when cached shapes change. */
export const CACHE_VERSIONS = {
  auth: 'v1',
  gateway: 'v1',
  media: 'v1',
  farm: 'v1',
  catalog: 'v1',
  product: 'v1',
  user: 'v1',
  order: 'v1',
  inventory: 'v1',
  payment: 'v1',
  notification: 'v1',
  call: 'v1',
  wallet: 'v1',
  support: 'v1',
  warehouse: 'v1',
} as const;

const authKeyspace = createKeyspace({ service: 'auth', version: CACHE_VERSIONS.auth });
const gatewayKeyspace = createKeyspace({ service: 'gateway', version: CACHE_VERSIONS.gateway });
const mediaKeyspace = createKeyspace({ service: 'media', version: CACHE_VERSIONS.media });

export const authKeys = {
  keyspace: authKeyspace,
  user: (id: string) => authKeyspace.key('user', id),
  session: (id: string) => authKeyspace.key('session', id),
  /** Account-recovery token (hash) → userId. Single use (GETDEL), TTL 10 min. */
  accountRecovery: (tokenHash: string) => authKeyspace.key('account-recovery', tokenHash),
  /** Session id revoked; written by auth-service, read by the gateway. */
  revokedSid: (sid: string) => authKeyspace.key('revoked', 'sid', sid),
  /** Access-token id blacklisted at logout; TTL = remaining token lifetime. */
  revokedJti: (jti: string) => authKeyspace.key('revoked', 'jti', jti),
  /** Pending MFA login challenge: `{ userId, attempts, … }`. TTL 5 min. */
  mfaChallenge: (id: string) => authKeyspace.key('mfa-challenge', id),
  /** Single-use password-reset token (stored by SHA-256). TTL 10 min. */
  passwordReset: (tokenHash: string) => authKeyspace.key('pwd-reset', tokenHash),
  loginFail: (email: string) => authKeyspace.key('login-fail', email),
  /**
   * Live OTP for one purpose and destination: `{ codeHmac, attempts, userId, channel }`.
   * `destHash` = HMAC-SHA256(pepper, phone|email) hex, so raw identifiers never appear in keys.
   * TTL 5 min; deleted on success or after max attempts (single use).
   */
  otp: (purpose: string, destHash: string) => authKeyspace.key('otp', purpose, destHash),
  /** Resend cooldown for an OTP purpose + destination. TTL 30–60 s. */
  otpCooldown: (purpose: string, destHash: string) =>
    authKeyspace.key('otp-cooldown', purpose, destHash),
  /** Fixed-window rate-limit counter, e.g. rateLimit('otp-send', 'dest', hash) / ('login', 'ip', ip). */
  rateLimit: (action: string, dimension: 'dest' | 'ip' | 'id' | 'user', value: string) =>
    authKeyspace.key('rl', action, dimension, value),
  /** Short-lived refresh-rotation grace marker: old session id → new session id. TTL ~10 s. */
  rotationGrace: (sid: string) => authKeyspace.key('rotation-grace', sid),
  /** Cached effective permissions for a user (invalidated on any role/assignment change). */
  permissions: (userId: string) => authKeyspace.key('perms', userId),
  /** Global RBAC version; a cached `perms` entry is valid only while its `v` equals this. */
  rbacVersion: () => authKeyspace.key('rbac-version'),
  lock: (resource: string) => authKeyspace.key('lock', resource),
  idempotency: (key: string) => authKeyspace.key('idem', key),
};

export const gatewayKeys = {
  keyspace: gatewayKeyspace,
  rateLimit: (id: string, route = 'default') => gatewayKeyspace.key('ratelimit', route, id),
  lock: (resource: string) => gatewayKeyspace.key('lock', resource),
};

const farmKeyspace = createKeyspace({ service: 'farm', version: CACHE_VERSIONS.farm });

export const farmKeys = {
  keyspace: farmKeyspace,
  /** Farm detail view. TTL 10 min; deleted after every write to the farm. */
  farm: (id: string) => farmKeyspace.key('farm', id),
  /** First page of a user's farms. TTL 5 min; deleted on create / status change. */
  userFarms: (userId: string) => farmKeyspace.key('user-farms', userId),
  /** Immutable Farm ID → farm id. TTL 7 days. */
  code: (farmCode: string) => farmKeyspace.key('code', farmCode),
  /** Pin-code master row. TTL 24 h; deleted on admin edit. */
  pin: (pinCode: string) => farmKeyspace.key('pin', pinCode),
  /** GST portal snapshot. TTL 24 h. */
  gstin: (gstin: string) => farmKeyspace.key('gstin', gstin),
  /** Pending Aadhaar OTP transaction of an owner. TTL 10 min. */
  aadhaarTxn: (ownerId: string) => farmKeyspace.key('aadhaar-txn', ownerId),
  /** Admin dashboard counters. TTL 60 s. */
  stats: () => farmKeyspace.key('stats'),
  rateLimit: (action: string, dimension: 'user' | 'ip' | 'owner', value: string) =>
    farmKeyspace.key('rl', action, dimension, value),
  /** Stored response of an idempotent POST, per user + Idempotency-Key. TTL 24 h. */
  idempotency: (userId: string, key: string) => farmKeyspace.key('idem', userId, key),
  /** Content generation: INCR on every reader-visible change; feed/detail keys embed it (no scans). */
  contentGen: () => farmKeyspace.key('content', 'gen'),
  /** One feed / search page for a reader segment (hash of the normalised query + gen). TTL 60 s. */
  contentPage: (gen: string, hash: string) => farmKeyspace.key('content', 'page', gen, hash),
  /** Published item detail by id or slug (+ gen). TTL 5 min. */
  contentDetail: (gen: string, idOrSlug: string) =>
    farmKeyspace.key('content', 'detail', gen, idOrSlug),
  /** Reader context (territory, production types, coordinates — server-side only). TTL 5 min. */
  contentReader: (userId: string, farmId: string) =>
    farmKeyspace.key('content', 'reader', userId, farmId),
  /** Per-reader daily view dedupe. TTL 24 h. */
  contentViewed: (contentId: string, userId: string) =>
    farmKeyspace.key('content', 'viewed', contentId, userId),
  /** Buffered engagement counters (hash field `<id>:<counter>`), flushed by content-tick. */
  contentCounters: () => farmKeyspace.key('content', 'counters'),
};

const catalogKeyspace = createKeyspace({ service: 'catalog', version: CACHE_VERSIONS.catalog });

export const catalogKeys = {
  keyspace: catalogKeyspace,
  /** Snapshot of every live category (flat rows + ETag). TTL 10 min; deleted after any write. */
  categoryTree: () => catalogKeyspace.key('category-tree'),
  /** Snapshot of every live, active brand (rows + ETag). TTL 10 min; deleted after any write. */
  brands: () => catalogKeyspace.key('brands'),
  /** Snapshot of live placements + their live banners (rows + ETag). TTL 5 min; deleted after any write. */
  banners: () => catalogKeyspace.key('banners'),
  rateLimit: (action: string, dimension: 'user' | 'ip', value: string) =>
    catalogKeyspace.key('rl', action, dimension, value),
  /** Stored response of an idempotent POST, per user + Idempotency-Key. TTL 24 h. */
  idempotency: (userId: string, key: string) => catalogKeyspace.key('idem', userId, key),
};

const productKeyspace = createKeyspace({ service: 'product', version: CACHE_VERSIONS.product });

export const productKeys = {
  keyspace: productKeyspace,
  /** Bumped (INCR) on every product write: list-cache keys embed it, so no key scans. */
  listVersion: () => productKeyspace.key('list-version'),
  /** One storefront list page (hash of the normalised query + listVersion). TTL 60 s. */
  list: (version: string, hash: string) => productKeyspace.key('list', version, hash),
  /** Storefront filter facets for one normalised selection (+ listVersion). TTL 60 s. */
  filters: (version: string, hash: string) => productKeyspace.key('filters', version, hash),
  /** Public product detail by slug. TTL 10 min; deleted after a write. */
  product: (slug: string) => productKeyspace.key('product', slug),
  rateLimit: (action: string, dimension: 'user' | 'ip', value: string) =>
    productKeyspace.key('rl', action, dimension, value),
  /** Stored response of an idempotent POST, per user + Idempotency-Key. TTL 24 h. */
  idempotency: (userId: string, key: string) => productKeyspace.key('idem', userId, key),
  /** Bumped (INCR) when a product's published reviews change: review-page keys embed it. */
  reviewsVersion: (productId: string) => productKeyspace.key('reviews-version', productId),
  /** One storefront review page (product + version + hash of the query). TTL 120 s. */
  reviewsPage: (productId: string, version: string, hash: string) =>
    productKeyspace.key('reviews', productId, version, hash),
  /** Public rating summary of a product. TTL 10 min; deleted after a change. */
  ratingSummary: (productId: string) => productKeyspace.key('rating-summary', productId),
  /** Masked reviewer name from auth-service ("Ramesh K."). TTL 24 h. */
  reviewAuthor: (userId: string) => productKeyspace.key('review-author', userId),
  /** Admin review analytics for one normalised query. TTL 5 min. */
  reviewAnalytics: (hash: string) => productKeyspace.key('review-analytics', hash),
};

const userKeyspace = createKeyspace({ service: 'user', version: CACHE_VERSIONS.user });

export const userKeys = {
  keyspace: userKeyspace,
  /** product-service card (or a 'missing' marker) for wishlist hydration. TTL 120 s. */
  productCard: (productId: string) => userKeyspace.key('product-card', productId),
  rateLimit: (action: string, dimension: 'user' | 'ip', value: string) =>
    userKeyspace.key('rl', action, dimension, value),
  /** Stored response of an idempotent POST, per user + Idempotency-Key. TTL 24 h. */
  idempotency: (userId: string, key: string) => userKeyspace.key('idem', userId, key),
};

const orderKeyspace = createKeyspace({ service: 'order', version: CACHE_VERSIONS.order });

export const orderKeys = {
  keyspace: orderKeyspace,
  rateLimit: (action: string, dimension: 'user' | 'ip', value: string) =>
    orderKeyspace.key('rl', action, dimension, value),
  /** Public offers page, per category filter ('all' = none). TTL 60 s. */
  publicOffers: (categoryId: string) => orderKeyspace.key('public-offers', categoryId),
  /** Admin order dashboard counters. TTL 30 s. */
  adminStats: () => orderKeyspace.key('admin-stats'),
};

const inventoryKeyspace = createKeyspace({
  service: 'inventory',
  version: CACHE_VERSIONS.inventory,
});

export const inventoryKeys = {
  keyspace: inventoryKeyspace,
  rateLimit: (action: string, dimension: 'user' | 'ip', value: string) =>
    inventoryKeyspace.key('rl', action, dimension, value),
  /** Allocation candidates for one PIN code (coverage + warehouse flags) at a coverage version. TTL 60 s. */
  coverage: (version: string, pinCode: string) =>
    inventoryKeyspace.key('coverage', version, pinCode),
  /** INCR on every warehouse / coverage write, so every cached coverage key is skipped at once. */
  coverageVersion: () => inventoryKeyspace.key('coverage-version'),
};

const paymentKeyspace = createKeyspace({ service: 'payment', version: CACHE_VERSIONS.payment });

export const paymentKeys = {
  keyspace: paymentKeyspace,
  rateLimit: (action: string, dimension: 'user' | 'ip', value: string) =>
    paymentKeyspace.key('rl', action, dimension, value),
  /** Mock gateway state of one payment (dev / test only). TTL 7 days. */
  mockPayment: (providerPaymentId: string) => paymentKeyspace.key('mock', 'pay', providerPaymentId),
  /** Mock gateway payment ids of one gateway order (dev / test only). */
  mockOrder: (providerOrderId: string) => paymentKeyspace.key('mock', 'order', providerOrderId),
  /** Mock gateway refunds of one payment (dev / test only). */
  mockRefunds: (providerPaymentId: string) =>
    paymentKeyspace.key('mock', 'refunds', providerPaymentId),
};

const notificationKeyspace = createKeyspace({
  service: 'notification',
  version: CACHE_VERSIONS.notification,
});

export const notificationKeys = {
  keyspace: notificationKeyspace,
  rateLimit: (action: string, dimension: 'user' | 'ip', value: string) =>
    notificationKeyspace.key('rl', action, dimension, value),
  /** Pub/sub channel carrying live inbox events to SSE streams on every replica. */
  liveChannel: () => notificationKeyspace.key('live'),
  /** Open SSE streams of one user (INCR / DECR, TTL refreshed by heartbeats). */
  streams: (userId: string) => notificationKeyspace.key('streams', userId),
};

const callKeyspace = createKeyspace({ service: 'call', version: CACHE_VERSIONS.call });

/**
 * call-service (D-53). Availability pages embed TWO generations, so no key is ever scanned:
 * `poolGen` (INCR on any expert / rule / break / time-off / holiday / settings change) and
 * `dayGen(date)` (INCR on any hold / booking change touching that IST date).
 */
export const callKeys = {
  keyspace: callKeyspace,
  rateLimit: (action: string, dimension: 'user' | 'ip', value: string) =>
    callKeyspace.key('rl', action, dimension, value),
  /** Stored response of an idempotent mutation, per user + Idempotency-Key. TTL 24 h. */
  idempotency: (userId: string, key: string) => callKeyspace.key('idem', userId, key),
  poolGen: () => callKeyspace.key('pool-gen'),
  /** `date` = IST calendar date `YYYY-MM-DD`. */
  dayGen: (date: string) => callKeyspace.key('day-gen', date),
  /** Slot grid / calendar-dots page. TTL 30 s. */
  availability: (poolGen: string, dayGen: string, hash: string) =>
    callKeyspace.key('avail', poolGen, dayGen, hash),
  /** Eligible expert pool for (brand, category). TTL 5 min. */
  pool: (poolGen: string, brandId: string, categoryId: string) =>
    callKeyspace.key('pool', poolGen, brandId, categoryId),
  /** Recommended-expert card. TTL 30 s. */
  recommended: (poolGen: string, hash: string) => callKeyspace.key('rec', poolGen, hash),
  /** Options + settings snapshot (+ ETag). TTL 10 min; deleted on write. */
  config: () => callKeyspace.key('config'),
  /** Expert app heartbeat. TTL 90 s; alive = online. */
  presence: (expertId: string) => callKeyspace.key('presence', expertId),
  /** Product storefront card. TTL 60 s. */
  productCard: (productId: string) => callKeyspace.key('product-card', productId),
  /** Price quote for a quantity. TTL 60 s (preview only; hold + confirm re-quote). */
  quote: (productId: string, qty: number) => callKeyspace.key('quote', productId, qty),
  /** Category ids root → self. TTL 10 min. */
  categoryPath: (categoryId: string) => callKeyspace.key('category-path', categoryId),
  /** Farm snapshot (ownership, territory). TTL 60 s. */
  farm: (farmId: string) => callKeyspace.key('farm', farmId),
};

export const mediaKeys = {
  keyspace: mediaKeyspace,
  /** Fixed-window upload counter per user (value is the user id). */
  uploadRateLimit: (userId: string) => mediaKeyspace.key('rl', 'upload', userId),
};

const walletKeyspace = createKeyspace({ service: 'wallet', version: CACHE_VERSIONS.wallet });

/**
 * wallet-service (D-54). Rate limits ONLY: balances, idempotency and ledger state live in
 * Postgres, never in Redis.
 */
export const walletKeys = {
  keyspace: walletKeyspace,
  rateLimit: (action: string, dimension: 'user' | 'ip', value: string) =>
    walletKeyspace.key('rl', action, dimension, value),
};

const supportKeyspace = createKeyspace({ service: 'support', version: CACHE_VERSIONS.support });

/**
 * support-service. Tickets, messages and SLA state live in Postgres; Redis holds caches, limits,
 * WebSocket connect tokens / counters and the realtime fan-out channel only.
 */
export const supportKeys = {
  keyspace: supportKeyspace,
  rateLimit: (action: string, dimension: 'user' | 'ip', value: string) =>
    supportKeyspace.key('rl', action, dimension, value),
  /** Generation of the config snapshot (INCR on every admin config write). */
  configGen: () => supportKeyspace.key('config-gen'),
  /** Config snapshot (settings, topics, rules, SLA, calendars) of one generation. TTL 10 min. */
  config: (gen: string) => supportKeyspace.key('config', gen),
  /** Generation of published help content (FAQ, legal). INCR on every content write. */
  contentGen: () => supportKeyspace.key('content-gen'),
  /** One cached help-content page of a generation. TTL 10 min. */
  content: (gen: string, hash: string) => supportKeyspace.key('content', gen, hash),
  /** Single-use WebSocket connect token. TTL 60 s. */
  wsToken: (token: string) => supportKeyspace.key('ws-token', token),
  /** Realtime fan-out channel (all replicas). */
  wsChannel: () => supportKeyspace.key('ws'),
  /** Open sockets of one user across replicas. TTL refreshed by heartbeats. */
  wsConnections: (userId: string) => supportKeyspace.key('ws-conns', userId),
  /** Inbound frame rate limit of one user. */
  wsRate: (userId: string) => supportKeyspace.key('ws-rl', userId),
  /** Agent presence (an open agent socket). TTL 90 s, refreshed while connected. */
  agentOnline: (userId: string) => supportKeyspace.key('agent-online', userId),
};

const warehouseKeyspace = createKeyspace({
  service: 'warehouse',
  version: CACHE_VERSIONS.warehouse,
});

/** warehouse-service (D-56). Master data lives in Postgres; Redis holds limits and caches. */
export const warehouseKeys = {
  keyspace: warehouseKeyspace,
  rateLimit: (action: string, dimension: 'user' | 'ip', value: string) =>
    warehouseKeyspace.key('rl', action, dimension, value),
  /** Staff contact (name, email, phone) from auth-service. TTL 5 min. */
  contact: (userId: string) => warehouseKeyspace.key('contact', userId),
  /** Visible catalog categories (id → name). TTL 10 min. */
  categories: () => warehouseKeyspace.key('categories'),
};
