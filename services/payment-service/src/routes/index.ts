import type { DocsOptions, ServiceModule } from '@farmx/common/server';

import type { PaymentConfig } from '../config/index.js';
import { auditModule } from '../features/audit/index.js';
import {
  ADMIN_PAYMENTS_TAG,
  PAYMENTS_TAG,
  paymentsAdminModule,
  paymentsInternalModule,
  paymentsModule,
} from '../features/payments/index.js';
import { ADMIN_REFUNDS_TAG, refundsModule } from '../features/refunds/index.js';
import { settingsModule } from '../features/settings/index.js';
import { WEBHOOKS_TAG, webhooksModule } from '../features/webhooks/index.js';

/**
 * payment-service (D-37, D-45): the ONLY service that talks to the payment gateway. Gateway maps
 *   /v1/payments/*        → /payments/*        buyers (status, verify, mock checkout in dev)
 *   /v1/webhooks/*        → /webhooks/*        Razorpay (signed raw body)
 *   /v1/admin/payments/*  → /admin/payments/*  staff
 *   /v1/admin/refunds/*   → /admin/refunds/*   staff
 * `/internal/payments/*` (order-service) is never routed by the gateway.
 */
export const features: readonly ServiceModule[] = [
  auditModule,
  settingsModule,
  paymentsModule,
  paymentsAdminModule,
  paymentsInternalModule,
  refundsModule,
  webhooksModule,
];

/** Spec only (`/api-docs.json`); the gateway merges it into the single FarmX Swagger UI. */
export const createDocsOptions = (config: PaymentConfig): DocsOptions => ({
  title: 'FarmX Payment Service API',
  version: config.SERVICE_VERSION,
  description: `Payments for orders (Razorpay; ${config.PAYMENT_PROVIDER === 'mock' ? '**MOCK gateway active: no money moves**' : 'live gateway'}): status, checkout verification, signed webhooks, refunds with approval and retries, reconciliation. Prepaid only; no card or bank data is ever stored.`,
  tags: [
    { name: 'Health', description: 'Public liveness and readiness probes.' },
    { name: PAYMENTS_TAG, description: 'Buyer: payment status and checkout verification (+ mock checkout in dev).' },
    { name: WEBHOOKS_TAG, description: 'Gateway → FarmX notifications (signed).' },
    { name: ADMIN_PAYMENTS_TAG, description: 'Payments, attempts, webhook log, reconcile.' },
    { name: ADMIN_REFUNDS_TAG, description: 'Refund execution: approve large manual refunds, retry failed ones.' },
  ],
});
