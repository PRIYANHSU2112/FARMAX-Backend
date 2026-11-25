import { randomUUID } from 'node:crypto';

import { AppError, ErrorCode } from '@farmx/common/errors';
import type { AuthUser } from '@farmx/common/types';
import { asValue } from 'awilix';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import type { Grants } from '../../src/adapters/auth.js';
import type { StaffContact } from '../../src/adapters/auth-client.js';
import { combineHandlers } from '../../src/adapters/events.js';
import type { FulfilmentFacts } from '../../src/adapters/order-client.js';
import { buildApp } from '../../src/app.js';

/**
 * Integration tests against a REAL Postgres with the migrations applied (local dev DB, never Neon):
 *   WAREHOUSE_IT_DATABASE_URL=postgresql://farmx:farmx@127.0.0.1:5433/farmx pnpm --filter @farmx/warehouse-service test
 * Skipped when the variable is not set. Redis is an in-memory stub; the bearer token IS the user
 * id; each test user carries its own grants (GLOBAL and per warehouse).
 */
export const DB_URL = process.env.WAREHOUSE_IT_DATABASE_URL;

const users = new Map<string, { user: AuthUser; grants: Grants }>();

/** A staff user with GLOBAL keys and optional per-warehouse keys. */
export const staff = (permissions: string[], warehouses: Record<string, string[]> = {}): string => {
  const id = randomUUID();
  users.set(id, {
    user: {
      id,
      sessionId: 's',
      jti: 'j',
      userType: 'INTERNAL',
      roles: ['it_role'],
      scope: 'full',
      expiresAt: 0,
    } as unknown as AuthUser,
    grants: { permissions, warehouses },
  });
  return id;
};

/** A signed-in CUSTOMER (customer app routes, D-57b). Returns the user id = token. */
export const customer = (): string => {
  const id = randomUUID();
  users.set(id, {
    user: {
      id,
      sessionId: 's',
      jti: 'j',
      userType: 'CUSTOMER',
      roles: [],
      scope: 'full',
      expiresAt: 0,
    } as unknown as AuthUser,
    grants: { permissions: [], warehouses: {} },
  });
  return id;
};

/** Gives an existing test user extra keys at one warehouse (after the warehouse exists). */
export const grantAt = (userId: string, warehouseId: string, keys: string[]): void => {
  const u = users.get(userId);
  if (u === undefined) throw new Error('unknown test user');
  u.grants = { ...u.grants, warehouses: { ...u.grants.warehouses, [warehouseId]: keys } };
};

const memoryRedis = () => {
  const store = new Map<string, string>();
  return {
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    mget: (...keys: string[]) => Promise.resolve(keys.map((k) => store.get(k) ?? null)),
    del: (...keys: string[]) => Promise.resolve(keys.filter((k) => store.delete(k)).length),
    // `SET k v EX n NX` honours NX (idempotency claims); EX is ignored in tests.
    set: (k: string, v: string, ...args: (string | number)[]) => {
      if (args.includes('NX') && store.has(k)) return Promise.resolve(null);
      store.set(k, v);
      return Promise.resolve('OK');
    },
    // D-62 gate cache version counter.
    incr: (k: string) => {
      const n = Number(store.get(k) ?? '0') + 1;
      store.set(k, String(n));
      return Promise.resolve(n);
    },
    multi: () => {
      const ops: (() => void)[] = [];
      const chain = {
        set: (k: string, v: string) => {
          ops.push(() => store.set(k, v));
          return chain;
        },
        exec: () => {
          ops.forEach((op) => {
            op();
          });
          return Promise.resolve([]);
        },
      };
      return chain;
    },
    // Rate limiter (Lua) → "Redis down" → the guard allows.
    eval: () => Promise.reject(new Error('no lua in tests')),
    ping: () => Promise.resolve('PONG'),
  };
};

/** Staff directory stub: every id is an ACTIVE staff user named after its first characters. */
const contactOf = (id: string): StaffContact => ({
  id,
  userType: 'INTERNAL',
  status: 'ACTIVE',
  fullName: `Staff ${id.slice(0, 4)}`,
  email: null,
  phone: '+919876543210',
});

/** auth-service team stub: members per warehouse (invite grants, revoke removes). */
export const members = new Map<string, Map<string, { roleId: string; roleKey: string }>>();
export const TEMPLATE = {
  id: '0193a5f2-7c1e-7b2a-9f00-00000000f001',
  key: 'picker',
  name: 'Picker',
  description: null,
  permissions: ['inventory.pick'],
  usage: { staffCount: 0, warehouseCount: 0 },
};
const teamStub = {
  warehouseRoles: () => Promise.resolve([TEMPLATE]),
  scopeMembers: (warehouseId: string) =>
    Promise.resolve(
      [...(members.get(warehouseId) ?? new Map<string, { roleId: string; roleKey: string }>())].map(
        ([userId, r]) => ({
          userId,
          roles: [{ roleId: r.roleId, roleKey: r.roleKey, roleName: 'Picker', assignedAt: '' }],
        }),
      ),
    ),
  invite: (b: { email: string; roleId: string; warehouseId: string }) => {
    const userId = emailIds.get(b.email) ?? randomUUID();
    emailIds.set(b.email, userId);
    const at = members.get(b.warehouseId) ?? new Map<string, { roleId: string; roleKey: string }>();
    const granted = at.get(userId)?.roleId !== b.roleId;
    at.set(userId, { roleId: b.roleId, roleKey: 'picker' });
    members.set(b.warehouseId, at);
    return Promise.resolve({
      userId,
      created: true,
      granted,
      invitationSent: true,
      status: 'PENDING_VERIFICATION',
    });
  },
  resend: () => Promise.resolve({ invitationSent: true }),
  revoke: (b: { userId: string; warehouseId: string }) => {
    const removed = members.get(b.warehouseId)?.delete(b.userId) === true;
    return Promise.resolve({ revoked: removed ? 1 : 0 });
  },
  forget: () => Promise.resolve(),
};
const emailIds = new Map<string, string>();

export const INTERNAL_TOKEN = 'it-internal-token-0123456789abcdef0123456789';

/** What the inventory stub answers to the stats job (null = inventory down). Tests set `rows`. */
export const inventoryStats: { rows: unknown[] | null } = { rows: [] };

/**
 * D-57a inventory cutover stub: writes mode, pending operations, a stock-level snapshot and ledger
 * rows for the re-cutover replay. Tests set `levels` / `ledger` before running the cutover.
 */
export const inventoryCutover = {
  mode: 'INVENTORY' as 'INVENTORY' | 'FROZEN' | 'WMS',
  pending: [] as { id: string }[],
  levels: [] as Record<string, unknown>[],
  ledger: [] as Record<string, unknown>[],
  calls: [] as string[],
};

/** order-service stub (D-57b): facts per order, compliance rejections, counts. */
export const orderService = {
  facts: new Map<string, FulfilmentFacts>(),
  rejected: [] as { orderId: string; reason: string }[],
  cancelled: [] as { orderId: string; lines: { variantId: string; qty: number }[] }[],
  deliveryUpdates: [] as { orderId: string; body: Record<string, unknown> }[],
  refunds: [] as {
    orderId: string;
    shipmentId: string;
    lines: { lineNo: number; qty: number }[];
  }[],
  /** D-61 gate-out invoice calls (in order) and the next answers (default: issue). */
  invoiceCalls: [] as {
    orderId: string;
    shipmentId: string;
    lines: { lineNo: number; qty: number }[];
    linesHash: string;
  }[],
  invoiceAnswer: null as
    null | { ok: false; conflict: { message: string; details: unknown } } | 'UNAVAILABLE',
  /** Invoices issued per shipment id (the stub's "order-service"). */
  invoices: new Map<string, { docNo: string; linesHash: string }>(),
};

/** inventory reservation stub (D-57b): reallocate answers + held lines per warehouse. */
export const inventoryReservations = {
  reallocate: [] as { reservationId: string; key: string; moves: unknown[] }[],
  answer: { ok: true, replayed: false } as
    | { ok: true; replayed: boolean }
    | { ok: false; definitive: boolean; reason: string; message: string },
  openLines: new Map<
    string,
    {
      reservationId: string;
      orderRef: string;
      variantId: string;
      heldQty: number;
      issuedQty: number;
    }[]
  >(),
};

/** inventory availability stub (D-57b W3.13 ATP): buffer floor, lease, resync calls. */
export const inventoryAvailability = {
  settings: {
    bufferFloorPct: 0,
    reservationTtlSeconds: 600,
    allowSplitAllocation: true,
    updatedAt: null as string | null,
  },
  resyncs: [] as (string | null)[],
};

/** product-service facts stub: tests register variants here (lazy projection fill). */
export const productFacts = new Map<string, Record<string, unknown>>();

/** Deliver one event to the warehouse-service inbox handlers (inside a transaction). */
export const deliver = async (app: FastifyInstance, type: string, data: object): Promise<void> => {
  const handler = combineHandlers(
    app.diContainer.resolve('orderEventHandlers'),
    app.diContainer.resolve('stockEventHandlers'),
    app.diContainer.resolve('fulfilmentEventHandlers'),
    app.diContainer.resolve('atpEventHandlers'),
  )[type];
  if (handler === undefined) throw new Error(`no handler for ${type}`);
  await app.diContainer.resolve('runInTransaction')((tx) =>
    handler(
      {
        id: randomUUID(),
        type,
        version: 1,
        occurredAt: new Date().toISOString(),
        source: 'it',
        correlationId: randomUUID(),
        data,
      },
      tx,
    ),
  );
};

export const buildTestApp = async (): Promise<FastifyInstance> => {
  const app = await buildApp({
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.IT_LOG_LEVEL ?? 'silent',
    DATABASE_URL: DB_URL,
    DB_POOL_SIZE: '10',
    INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
  });
  app.diContainer.register({
    redis: asValue(memoryRedis() as never),
    accessClient: asValue({
      grants: (userId: string) =>
        Promise.resolve(users.get(userId)?.grants ?? { permissions: [], warehouses: {} }),
    } as never),
    authClient: asValue({
      contacts: (ids: string[]) => Promise.resolve(new Map(ids.map((id) => [id, contactOf(id)]))),
      requireStaffUser: (id: string) => Promise.resolve(contactOf(id)),
      verifyStepUp: (_userId: string, code: string) =>
        Promise.resolve({ valid: code === '123456', locked: false }),
      ...teamStub,
    } as never),
    // Category checks are skipped when the catalog cannot be read (null).
    catalogClient: asValue({ categories: () => Promise.resolve(null) } as never),
    orderClient: asValue({
      issueShipmentInvoice: (
        orderId: string,
        shipmentId: string,
        body: { lines: { lineNo: number; qty: number }[]; linesHash: string },
      ) => {
        orderService.invoiceCalls.push({ orderId, shipmentId, ...body });
        const a = orderService.invoiceAnswer;
        if (a === 'UNAVAILABLE')
          return Promise.reject(
            new AppError(ErrorCode.SERVICE_UNAVAILABLE, 'Invoice service unavailable', 503, {
              details: { reason: 'INVOICE_UNAVAILABLE' },
            }),
          );
        if (a !== null) return Promise.resolve(a);
        const prev = orderService.invoices.get(shipmentId);
        const replayed = prev?.linesHash === body.linesHash;
        const docNo = replayed
          ? prev.docNo
          : 'FX/2627/' + String(orderService.invoices.size + 1).padStart(7, '0');
        orderService.invoices.set(shipmentId, { docNo, linesHash: body.linesHash });
        return Promise.resolve({
          ok: true,
          invoice: {
            docId: shipmentId,
            docNo,
            docType: 'TAX_INVOICE',
            grandTotalPaise: 6_000_000,
            grandTotal: '60000.00',
            issuedAt: new Date().toISOString(),
            linesHash: body.linesHash,
            replayed,
            voidedDocNo: prev !== undefined && !replayed ? prev.docNo : null,
          },
        });
      },
      shipmentInvoicePdf: (_orderId: string, shipmentId: string) => {
        const inv = orderService.invoices.get(shipmentId);
        return Promise.resolve(
          inv === undefined ? null : { file: Buffer.from('%PDF-1.4 test'), docNo: inv.docNo },
        );
      },
      fulfilmentFacts: (id: string) => Promise.resolve(orderService.facts.get(id) ?? null),
      counts: () => Promise.resolve({}),
      shortageRefund: (
        orderId: string,
        body: { shipmentId: string; lines: { lineNo: number; qty: number }[] },
      ) => {
        orderService.refunds.push({ orderId, ...body });
        return Promise.resolve({ sourceRef: 'shortage:' + body.shipmentId, amount: '50.00' });
      },
      updateDelivery: (orderId: string, body: Record<string, unknown>) => {
        orderService.deliveryUpdates.push({ orderId, body });
        return Promise.resolve({ id: orderId, version: 2 });
      },
      cancelLines: (orderId: string, body: { lines: { variantId: string; qty: number }[] }) => {
        orderService.cancelled.push({ orderId, lines: body.lines });
        return Promise.resolve({ orderId, status: 'CONFIRMED' });
      },
      complianceReject: (orderId: string, reason: string) => {
        orderService.rejected.push({ orderId, reason });
        return Promise.resolve({ status: 'REJECTED' });
      },
    } as never),
    inventoryClient: asValue({
      reallocate: (reservationId: string, key: string, moves: unknown[]) => {
        inventoryReservations.reallocate.push({ reservationId, key, moves });
        return Promise.resolve(inventoryReservations.answer);
      },
      openLines: (warehouseId: string) =>
        Promise.resolve({
          items: inventoryReservations.openLines.get(warehouseId) ?? [],
          nextCursor: null,
        }),
      warehouseStats: () => Promise.resolve(inventoryStats.rows),
      availabilitySettings: () => Promise.resolve({ ...inventoryAvailability.settings }),
      setAvailabilitySettings: (b: { bufferFloorPct?: number; reservationTtlSeconds?: number }) => {
        if (b.bufferFloorPct !== undefined)
          inventoryAvailability.settings.bufferFloorPct = b.bufferFloorPct;
        if (b.reservationTtlSeconds !== undefined)
          inventoryAvailability.settings.reservationTtlSeconds = b.reservationTtlSeconds;
        return Promise.resolve({ ...inventoryAvailability.settings });
      },
      resyncAvailability: (warehouseId: string | null) => {
        inventoryAvailability.resyncs.push(warehouseId);
        return Promise.resolve({ variants: 3 });
      },
      cutoverState: () =>
        Promise.resolve({
          mode: inventoryCutover.mode,
          pendingOperations: inventoryCutover.pending,
        }),
      cutoverStep: (step: string) => {
        inventoryCutover.calls.push(step);
        inventoryCutover.mode =
          step === 'freeze' ? 'FROZEN' : step === 'activate' ? 'WMS' : 'INVENTORY';
        return Promise.resolve({ mode: inventoryCutover.mode });
      },
      rejectPending: () => {
        const ids = inventoryCutover.pending.map((p) => p.id);
        inventoryCutover.pending = [];
        return Promise.resolve(ids);
      },
      snapshot: (cursor?: string) =>
        Promise.resolve(cursor === undefined ? inventoryCutover.levels : []),
      ledgerSince: (_since: Date, cursor?: string) =>
        Promise.resolve(cursor === undefined ? inventoryCutover.ledger : []),
    } as never),
    productClient: asValue({
      variantFacts: (ids: string[]) =>
        Promise.resolve(ids.flatMap((id) => (productFacts.has(id) ? [productFacts.get(id)] : []))),
    } as never),
    tokenVerifier: asValue((token: string) => {
      const u = users.get(token);
      return u === undefined ? Promise.reject(new Error('bad token')) : Promise.resolve(u.user);
    }),
  });
  await app.ready();
  return app;
};

export const call = (
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  user?: string,
  payload?: object,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    headers: { ...headers, ...(user === undefined ? {} : { authorization: `Bearer ${user}` }) },
    ...(payload === undefined ? {} : { payload }),
  });

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test reads
export const data = <T = Record<string, unknown>>(res: LightMyRequestResponse) =>
  res.json<{ data: T }>().data;

export const errorOf = (res: LightMyRequestResponse) =>
  res.json<{
    error: { code: string; message: string; details?: { reason?: string; issues?: unknown[] } };
  }>().error;

/** Outbox events of one type about one warehouse, oldest first. */
export const outbox = async (app: FastifyInstance, type: string, warehouseId: string) => {
  const rows = await app.diContainer.resolve('db').outboxEvent.findMany({
    where: { type },
    orderBy: { createdAt: 'asc' },
    select: { payload: true },
  });
  return rows
    .map((r) => (r.payload as { data: Record<string, unknown> }).data)
    .filter((d) => d.warehouseId === warehouseId);
};

export const randomCode = (prefix: string): string =>
  `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;

/** A PIN area nobody else uses in these tests (9xx xxx). */
export const randomPinBase = (): number => 900_000 + Math.floor(Math.random() * 98) * 1_000;

/** Weekly hours Mon–Sat 06:00–22:00, Sunday closed. */
export const WEEK = [1, 2, 3, 4, 5, 6, 7].map((isoDay) => ({
  isoDay,
  isOpen: isoDay < 7,
  opensAt: isoDay < 7 ? '06:00' : null,
  closesAt: isoDay < 7 ? '22:00' : null,
}));

/** Storage + calendar steps of the activation checklist (one zone, weekly hours). */
export const prepareSetup = async (app: FastifyInstance, user: string, id: string) => {
  const zone = await call(app, 'POST', `/admin/warehouses/${id}/zones`, user, {
    code: 'A',
    name: 'Feed',
    temperatureClass: 'AMB',
  });
  if (zone.statusCode !== 201) throw new Error(zone.body);
  const hours = await call(app, 'PUT', `/admin/warehouses/${id}/operating-hours`, user, {
    days: WEEK,
  });
  if (hours.statusCode !== 200) throw new Error(hours.body);
};
