import type { DocsOptions, ServiceModule } from '@farmx/common/server';

import type { FarmConfig } from '../config/index.js';
import { auditModule } from '../features/audit/index.js';
import {
  ADMIN_FARMS_TAG,
  FARMS_TAG,
  farmsAdminModule,
  farmsInternalModule,
  farmsModule,
} from '../features/farms/index.js';
import {
  ADMIN_CONTENT_TAG,
  CONTENT_TAG,
  contentAdminModule,
  contentInternalModule,
  contentModule,
} from '../features/content/index.js';
import { ADMIN_GEO_TAG, GEO_TAG, geoAdminModule, geoModule } from '../features/geo/index.js';
import { ADMIN_KYC_TAG, KYC_TAG, kycAdminModule, kycModule } from '../features/kyc/index.js';
import {
  ADMIN_REVIEW_TAG,
  VERIFICATION_TAG,
  reviewAdminModule,
  reviewModule,
} from '../features/review/index.js';

/**
 * Every feature of farm-service. The gateway maps `/v1/farms/*` → `/farms/*` and
 * `/v1/admin/farms/*` → `/admin/farms/*` (no rewrite), and `/v1/farm-service/*` → `/*` (docs, health).
 *   /farms · /farms/:id/*                farms (journey, pass)
 *   /farms/geo/*                          geo   · /farms/:id/kyc/*, /billing  kyc
 *   /farms/:id/verification*              review
 *   /admin/farms/*                        farms-admin, kyc-admin, review-admin, geo-admin
 *   /farms/content/*                      content (news feed, alerts, knowledge library)
 *   /admin/farms/content/*                content-admin
 *   /internal/farms/*                     farms-internal, content-internal (internal token, hidden)
 */
export const features: readonly ServiceModule[] = [
  auditModule,
  geoModule,
  farmsModule,
  kycModule,
  reviewModule,
  contentModule,
  farmsAdminModule,
  kycAdminModule,
  reviewAdminModule,
  geoAdminModule,
  contentAdminModule,
  farmsInternalModule,
  contentInternalModule,
];

export const createDocsOptions = (config: FarmConfig): DocsOptions => ({
  title: 'FarmX Farm Service API',
  version: config.SERVICE_VERSION,
  description:
    'Farm owners, farm units and the permanent Farm ID: 5-step registration, KYC (Aadhaar OTP, PAN, GSTIN), duplicate review and admin management.\n\n' +
    'Conventions: `{ success, data, meta? }` envelope · cursor pagination (`cursor`, `limit` ≤ 100) · `If-Match: <version>` on writes · `Idempotency-Key` on creating POSTs · 422 lists every invalid field.',
  // Paths in the spec are /farms/… and /admin/farms/…, which the gateway serves under /v1.
  servers: [{ url: config.FARM_DOCS_SERVER_URL, description: 'Via the API gateway' }],
  tags: [
    { name: 'Health', description: 'Public liveness and readiness probes.' },
    { name: FARMS_TAG, description: 'Customer registration journey, my farms and the Farm pass.' },
    { name: GEO_TAG, description: 'Pin code → district, mandal, territory and serving node.' },
    {
      name: KYC_TAG,
      description: 'Aadhaar OTP (consent), PAN, GSTIN and documents. PII is masked.',
    },
    { name: VERIFICATION_TAG, description: 'Under review / needs attention screens.' },
    {
      name: ADMIN_FARMS_TAG,
      description: 'Search, detail, corrections and status actions (audited).',
    },
    { name: ADMIN_REVIEW_TAG, description: 'Duplicate-registration queue and decisions.' },
    { name: ADMIN_KYC_TAG, description: 'KYC document review.' },
    { name: ADMIN_GEO_TAG, description: 'Territory and pin-code masters.' },
    {
      name: CONTENT_TAG,
      description:
        'News & updates feed, disease alerts, search, saved items and offline sync of the knowledge library.',
    },
    {
      name: ADMIN_CONTENT_TAG,
      description:
        'Authoring → vet sign-off → approval (different people), corrections, takedowns, topics and the verified reviewer register.',
    },
  ],
});
