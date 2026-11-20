import { readFileSync, writeFileSync } from 'node:fs';
const rep = (p, pairs) => {
  let s = readFileSync(p, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error(`${p}: ${a.slice(0, 80)}`);
    s = s.replace(a, b);
  }
  writeFileSync(p, s);
};
const S = 'src';

// 1. payment client: DB totals of one payment (no gateway call).
rep(`${S}/adapters/internal-clients.ts`, [
  [
    '  /** Gateway refetch (lost-webhook guard before timing an order out). */',
    `  /** Stored totals of one payment (ledger reconciliation; no gateway call). */
  async totals(paymentId: string): Promise<{ capturedPaise: number; refundedPaise: number }> {
    const p = await this.http.call<{ capturedPaise: number; refundedPaise: number }>(
      'GET',
      \`/internal/payments/\${paymentId}\`,
    );
    return { capturedPaise: p.capturedPaise, refundedPaise: p.refundedPaise };
  }

  /** Gateway refetch (lost-webhook guard before timing an order out). */`,
  ],
]);

// 2. event handlers: ledger row first (same inbox tx), then the lifecycle.
rep(`${S}/features/orders/orders.events.ts`, [
  [
    "export const createOrderEventHandlers = ({\n  orderLifecycle: life,\n}: Pick<Cradle, 'orderLifecycle'>): EventHandlerMap => {",
    "export const createOrderEventHandlers = ({\n  orderLifecycle: life,\n  transactionsService: ledger,\n}: Pick<Cradle, 'orderLifecycle' | 'transactionsService'>): EventHandlerMap => {",
  ],
  [
    "    'payment.captured.v1': (e, tx) => life.onPaymentCaptured(tx, e.data as PaymentCapturedV1, ctx(e)),",
    "    // Money events: the ledger row is written first (idempotent by key, same transaction), so it\n    // exists exactly when the event was processed, whatever the lifecycle then decides.\n    'payment.captured.v1': async (e, tx) => {\n      await ledger.recordCapture(tx, e);\n      await life.onPaymentCaptured(tx, e.data as PaymentCapturedV1, ctx(e));\n    },",
  ],
  [
    "    'payment.refund_processed.v1': (e, tx) => life.onRefundProcessed(tx, e.data as RefundProcessedV1),",
    "    'payment.refund_processed.v1': async (e, tx) => {\n      await ledger.recordRefund(tx, e);\n      await life.onRefundProcessed(tx, e.data as RefundProcessedV1);\n    },",
  ],
]);

// 3. services: ownership-checked ledger reads.
rep(`${S}/features/orders/orders.service.ts`, [
  ["  | 'paymentClient'\n", "  | 'paymentClient'\n  | 'transactionsService'\n"],
  [
    '  async get(user: AuthUser, orderId: string): Promise<OrderDetailView> {',
    `  /** The buyer's money ledger for one own order (another buyer's id → 404). */
  async transactions(user: AuthUser, orderId: string): Promise<OrderLedgerView> {
    await this.owned(user, orderId);
    return this.deps.transactionsService.forOrder(orderId);
  }

  async get(user: AuthUser, orderId: string): Promise<OrderDetailView> {`,
  ],
]);
let s = readFileSync(`${S}/features/orders/orders.service.ts`, 'utf8');
s = s.replace(
  /(\nimport [^\n]*from '\.\.\/promotions\/index\.js';)/,
  "$1\nimport type { OrderLedgerView } from '../transactions/index.js';",
);
if (!s.includes("from '../transactions/index.js'")) throw new Error('orders.service import');
writeFileSync(`${S}/features/orders/orders.service.ts`, s);

rep(`${S}/features/orders/orders.admin.service.ts`, [
  ["  | 'auditService'\n", "  | 'auditService'\n  | 'transactionsService'\n"],
  [
    '  async detail(id: string): Promise<AdminOrderView> {',
    `  /** Money ledger of any order (staff). */
  async transactions(id: string): Promise<OrderLedgerView> {
    await this.mustFind(id);
    return this.deps.transactionsService.forOrder(id);
  }

  /** Payments whose ledger disagrees with payment-service (reconcile job). */
  ledgerMismatches(query: { cursor?: string; limit: number }): Promise<Paginated<LedgerCheckView>> {
    return this.deps.transactionsService.mismatches(query);
  }

  async detail(id: string): Promise<AdminOrderView> {`,
  ],
]);
s = readFileSync(`${S}/features/orders/orders.admin.service.ts`, 'utf8');
s = s.replace(
  /(\nimport type \{ Cradle \} from '@fastify\/awilix';)/,
  "\nimport type { Paginated } from '@farmx/common/types';$1",
);
s = s.replace(
  /(\nimport [^\n]*from '\.\.\/audit\/index\.js';)/,
  "$1\nimport type { LedgerCheckView, OrderLedgerView } from '../transactions/index.js';",
);
if (!s.includes("from '../transactions/index.js'")) throw new Error('admin service import');
writeFileSync(`${S}/features/orders/orders.admin.service.ts`, s);

// 4. permissions.
rep(`${S}/middleware/guards.ts`, [
  ["  'orders.view',\n", "  'orders.view',\n  'payments.view',\n"],
]);

// 5. job.
rep(`${S}/adapters/jobs.ts`, [
  [
    "    await every('recovery-watch', 5 * 60_000);",
    "    await every('recovery-watch', 5 * 60_000);\n    await every('ledger-reconcile', 15 * 60_000);",
  ],
  [
    "          case 'recovery-watch':",
    "          case 'ledger-reconcile':\n            return this.cradle.transactionsService.reconcile();\n          case 'recovery-watch':",
  ],
]);

// 6. module registration.
rep(`${S}/routes/index.ts`, [
  [
    "import { settingsModule } from '../features/settings/index.js';",
    "import { settingsModule } from '../features/settings/index.js';\nimport { transactionsModule } from '../features/transactions/index.js';",
  ],
  [
    '  settingsModule,\n  ordersModule,',
    '  settingsModule,\n  transactionsModule,\n  ordersModule,',
  ],
]);
