import type { DocsOptions, ServiceModule } from '@farmx/common/server';

import type { QualityConfig } from '../config/index.js';
import { CUSTOMER_TAG, PUBLIC_TAG, tagOf } from '../docs/shared.js';
import { AUDIT_AREA, auditAdminModule, auditModule } from '../features/audit/index.js';
import { certificatesModule, verifyModule } from '../features/certificates/index.js';
import { COAS_AREA, coasAdminModule, coasModule } from '../features/coas/index.js';
import { LABS_AREA, labsAdminModule, labsModule } from '../features/labs/index.js';
import { projectionsModule } from '../features/projections/index.js';
import { RELEASE_AREA, releaseAdminModule, releaseModule } from '../features/release/index.js';
import { SAMPLES_AREA, samplesAdminModule, samplesModule } from '../features/samples/index.js';
import { SPECS_AREA, specsAdminModule, specsModule } from '../features/specs/index.js';

/**
 * quality-service (D-60, W16 Sampling & COA). The gateway maps
 *   /v1/quality/*        → /quality/*        warehouse panel (scoped to the caller's warehouses)
 *   /v1/admin/quality/*  → /admin/quality/*  admin panel (GLOBAL grants), same handlers
 *   /v1/certificates/*   → /certificates/*   customer app (own consignments / units only)
 *   /v1/verify/*         → /verify/*         public verification (allow-listed facts)
 */
export const features: readonly ServiceModule[] = [
  auditModule,
  auditAdminModule,
  projectionsModule,
  labsModule,
  labsAdminModule,
  specsModule,
  specsAdminModule,
  samplesModule,
  samplesAdminModule,
  releaseModule,
  releaseAdminModule,
  coasModule,
  coasAdminModule,
  certificatesModule,
  verifyModule,
];

const AREAS: [string, string][] = [
  [
    SAMPLES_AREA,
    'Sampling dashboard, create sample request, sample details, laboratory test status (W16.01–W16.04).',
  ],
  [
    COAS_AREA,
    'COA review, certificate details, manufacturer COA upload + auto-linking, result entry, four-eyes review, validity (W16.05 / W16.06 / W16.10).',
  ],
  [
    RELEASE_AREA,
    'Release checklist and release / quarantine / recall decisions with per-warehouse progress (W16.07).',
  ],
  [SPECS_AREA, 'Per-SKU acceptance limits and release mode (W16.09).'],
  [LABS_AREA, 'Laboratory list (W16.08). Manual result entry; the LIMS connector is Future.'],
  [AUDIT_AREA, 'Append-only audit trail.'],
];

/** Spec only (`/api-docs.json`); the gateway merges it into the single FarmX Swagger UI. */
export const createDocsOptions = (config: QualityConfig): DocsOptions => ({
  title: 'FarmX Quality Service API',
  version: config.SERVICE_VERSION,
  description:
    'Sampling & COA (D-60, W16): labs, SKU specifications, samples, certificates of analysis, quality release / quarantine / recall (stock moves are executed by warehouse-service, one task per warehouse), customer certificates and public verification.',
  tags: [
    { name: 'Health', description: 'Public liveness and readiness probes.' },
    ...(['panel', 'admin'] as const).flatMap((aud) =>
      AREAS.map(([area, description]) => ({
        name: tagOf(aud, area),
        description: `${aud === 'admin' ? 'Admin panel (GLOBAL)' : 'Warehouse panel (scoped)'}: ${description}`,
      })),
    ),
    {
      name: CUSTOMER_TAG,
      description:
        'Customer app: my certificates, scan result & journey, consignment COA verification, notify-me.',
    },
    {
      name: PUBLIC_TAG,
      description: 'verify.farmx.in: goods, batch, certificates and verdict only (no login).',
    },
  ],
});
