import type { RouteDocs } from '@farmx/common/server';

import { AUTH_GLOBAL, AUTH_STAFF, IDS, VERSION_CONFLICT, tagOf } from '../../docs/shared.js';
import type { Audience } from '../../middleware/guards.js';

export const SPECS_AREA = 'SKU specifications (W16.09)';

const SPEC = {
  variantId: IDS.variant,
  product: {
    sku: 'TB-25',
    name: 'Toxin binder',
    variantName: '25 kg',
    brandName: 'Sri Venkata Feeds',
    packLabel: '25 KG',
    imageUrl: null,
  },
  configured: true,
  releaseMode: 'MANUFACTURER_COA',
  sampleOnReceipt: true,
  sampleQty: 3,
  sampleUnit: 'bags',
  defaultLabId: IDS.lab,
  coaValidityDays: 365,
  isActive: true,
  version: 2,
  params: [
    {
      code: 'MOISTURE',
      name: 'Moisture',
      unit: '%',
      rule: 'MAX',
      min: null,
      max: 12,
      expectedText: null,
      critical: false,
      sortOrder: 0,
      specLabel: '≤ 12 %',
    },
    {
      code: 'AFB1_BINDING',
      name: 'AFB1 binding',
      unit: '%',
      rule: 'MIN',
      min: 85,
      max: null,
      expectedText: null,
      critical: true,
      sortOrder: 1,
      specLabel: '≥ 85 %',
    },
    {
      code: 'PH',
      name: 'pH (10%)',
      unit: null,
      rule: 'RANGE',
      min: 7,
      max: 9,
      expectedText: null,
      critical: false,
      sortOrder: 2,
      specLabel: '7–9',
    },
    {
      code: 'LEAD',
      name: 'Lead (Pb)',
      unit: 'ppm',
      rule: 'MAX',
      min: null,
      max: 10,
      expectedText: null,
      critical: true,
      sortOrder: 3,
      specLabel: '≤ 10 ppm',
    },
  ],
  note: 'Acceptance limits require approved SKU-specific specifications.',
  updatedAt: '2026-11-25T05:00:00.000Z',
};

export const specsDocs = (aud: Audience) => {
  const tag = tagOf(aud, SPECS_AREA);
  const auth = AUTH_STAFF(aud);
  return {
    list: {
      tag,
      summary: 'SKU specifications',
      description:
        'Configured SKUs with their release mode and limits. `q` matches SKU or product name.',
      auth,
      permission: 'quality.view',
      success: {
        status: 200,
        description: 'Specs',
        paginated: true,
        example: { success: true, data: [SPEC], meta: { nextCursor: null, limit: 20 } },
      },
    },
    get: {
      tag,
      summary: 'Specification of one SKU',
      description:
        'W16.09. `configured: false` (version 0) when the SKU has no limits yet: save with `expectedVersion: 0`.',
      auth,
      permission: 'quality.view',
      errors: [404, 503],
      success: { status: 200, description: 'Spec', example: { success: true, data: SPEC } },
    },
    history: {
      tag,
      summary: 'Saved versions of a SKU specification',
      description:
        'Every result keeps the spec version it was judged against; this lists those versions.',
      auth,
      permission: 'quality.view',
      success: {
        status: 200,
        description: 'Versions',
        example: {
          success: true,
          data: [
            {
              version: 2,
              changedBy: IDS.user,
              changedAt: '2026-11-25T05:00:00.000Z',
              reason: 'Lead limit per FSSAI',
              snapshot: {},
            },
          ],
        },
      },
    },
    put: {
      tag,
      summary: 'Save specification (Save specification)',
      description:
        'Replaces the parameters and policy of the SKU, saves a version, writes the audit and publishes `quality.spec_changed.v1` in the same transaction (an active spec makes new receipts land in QC_HOLD). Rules: MIN needs min, MAX needs max, RANGE needs min ≤ max, TEXT needs expectedText. `releaseMode`: MANUFACTURER_COA (release after the manufacturer COA is approved; independent test in parallel) or INDEPENDENT_COA (release only after the independent COA passes).',
      auth: AUTH_GLOBAL,
      permission: 'quality.spec_manage',
      errors: [400, 404, 409, 503],
      requestExample: {
        releaseMode: 'MANUFACTURER_COA',
        sampleOnReceipt: true,
        sampleQty: 3,
        sampleUnit: 'bags',
        defaultLabId: IDS.lab,
        coaValidityDays: 365,
        isActive: true,
        params: [
          { code: 'MOISTURE', name: 'Moisture', unit: '%', rule: 'MAX', max: 12 },
          {
            code: 'AFB1_BINDING',
            name: 'AFB1 binding',
            unit: '%',
            rule: 'MIN',
            min: 85,
            critical: true,
          },
        ],
        reason: 'Initial limits from QA head',
        expectedVersion: 0,
      },
      errorExamples: { 409: VERSION_CONFLICT },
      success: { status: 200, description: 'Saved', example: { success: true, data: SPEC } },
    },
  } satisfies Record<string, RouteDocs>;
};
