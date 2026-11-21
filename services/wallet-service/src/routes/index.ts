import type { DocsOptions, ServiceModule } from '@farmx/common/server';

import type { WalletConfig } from '../config/index.js';
import { ADMIN_WALLET_TAG, adjustmentsModule } from '../features/adjustments/index.js';
import { auditModule } from '../features/audit/index.js';
import { checksModule } from '../features/checks/index.js';
import { consoleModule } from '../features/console/index.js';
import { WALLET_TAG, ledgerModule } from '../features/ledger/index.js';
import { purchasesInternalModule } from '../features/purchases/index.js';
import { REWARDS_TAG, rewardsModule } from '../features/rewards/index.js';
import { settingsModule } from '../features/settings/index.js';
import { statementsModule } from '../features/statements/index.js';
import { TOPUPS_TAG, topupsModule } from '../features/topups/index.js';

/**
 * wallet-service (D-54): the ONLY service that writes the wallet ledger. Gateway maps
 *   /v1/wallet/*   → /wallet/*   customers (own wallet)
 *   /v1/rewards/*  → /rewards/*  customers (own reward points)
 *   /v1/admin/wallet/* → /admin/wallet/*  staff (wallets, adjustments, ledger checks, settings)
 * Consumes payment.topup_*.v1 + payment.refund_processed.v1 (payment-service) and
 * order.delivered.v1 (F1). `/internal/*` is never routed by the gateway.
 */
export const features: readonly ServiceModule[] = [
  auditModule,
  settingsModule,
  ledgerModule,
  rewardsModule,
  topupsModule,
  purchasesInternalModule,
  statementsModule,
  adjustmentsModule,
  checksModule,
  consoleModule,
];

/** Spec only (`/api-docs.json`); the gateway merges it into the single FarmX Swagger UI. */
export const createDocsOptions = (config: WalletConfig): DocsOptions => ({
  title: 'FarmX Wallet Service API',
  version: config.SERVICE_VERSION,
  description:
    'Closed-loop customer wallet on a double-entry, append-only PostgreSQL ledger (integer paise, idempotent, row-locked). No transfer or withdrawal.',
  tags: [
    { name: 'Health', description: 'Public liveness and readiness probes.' },
    { name: WALLET_TAG, description: 'Customer: balance and the last 7 days.' },
    {
      name: TOPUPS_TAG,
      description: 'Customer: Add Money (UPI, Net Banking, Card) and the success modal.',
    },
    {
      name: REWARDS_TAG,
      description: 'Customer: points summary, Points Ledger, convert points to wallet money.',
    },
    {
      name: ADMIN_WALLET_TAG,
      description:
        'Staff: wallets, journals, freeze, manual adjustments (two-person approval), ledger checks, rules.',
    },
  ],
});
