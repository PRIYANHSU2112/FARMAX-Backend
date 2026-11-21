import type { DocsOptions, ServiceModule } from '@farmx/common/server';

import type { CallConfig } from '../config/index.js';
import { auditModule } from '../features/audit/index.js';
import { ADMIN_EXPERTS_TAG, CALLS_TAG, EXPERT_SELF_TAG, expertsModule } from '../features/experts/index.js';
import { ADMIN_CALL_CONFIG_TAG, optionsModule } from '../features/options/index.js';

/**
 * call-service (D-53): Book a Sales Call. Everything lives under `/calls` (gateway `/v1/calls/*`):
 *   /calls/experts/recommended      customer   recommended-expert card (not a booking)
 *   /calls/experts/me/*             expert     own profile, presence, availability, time-off
 *   /calls/admin/experts|holidays   staff      experts, availability, time-off, holidays
 *   /calls/admin/options|settings   staff      chips and rules
 * `/internal/*` is never routed by the gateway.
 */
export const features: readonly ServiceModule[] = [auditModule, optionsModule, expertsModule];

/** Spec only (`/api-docs.json`); the gateway merges it into the single FarmX Swagger UI. */
export const createDocsOptions = (config: CallConfig): DocsOptions => ({
  title: 'FarmX Call Service API',
  version: config.SERVICE_VERSION,
  description: `Book a Sales Call (C-12a/d/e): recommended expert, pooled availability, slot holds, bookings, consents, call journey. Telephony provider: **${config.TELEPHONY_PROVIDER}** (mock = no real calls; refused in prod).`,
  tags: [
    { name: 'Health', description: 'Public liveness and readiness probes.' },
    { name: CALLS_TAG, description: 'Farmer: Schedule a Call flow.' },
    { name: EXPERT_SELF_TAG, description: 'Expert app: my profile, online status, availability, time-off.' },
    { name: ADMIN_EXPERTS_TAG, description: 'Experts, weekly availability, time-off, holidays.' },
    { name: ADMIN_CALL_CONFIG_TAG, description: 'Booking chips (options) and rules (settings).' },
  ],
});
