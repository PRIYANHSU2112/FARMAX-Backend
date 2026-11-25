import type { RouteDocs } from '@farmx/common/server';

import { AUTH_STAFF, IDS, VERSION_CONFLICT, tagOf } from '../../docs/shared.js';
import type { Audience } from '../../middleware/guards.js';
import type { SampleAction } from './samples.rules.js';

export const SAMPLES_AREA = 'Samples (W16.01–W16.04)';

const ROW = {
  id: IDS.sample,
  sampleNo: 'SMP-2026-0048',
  status: 'COLLECTED',
  bucket: 'pending',
  source: 'AUTO',
  batchId: IDS.batch,
  batchNo: 'B2408',
  product: {
    variantId: IDS.variant,
    sku: 'ND-LASOTA',
    name: 'ND LaSota vaccine',
    variantName: '1000 doses',
  },
  warehouseId: IDS.warehouse,
  cnNo: 'CN-2026-0048',
  qty: 3,
  qtyUnit: 'units',
  lab: { id: IDS.lab, name: 'FarmX QA Lab', type: 'IN_HOUSE' },
  labRef: null,
  expectedResultAt: null,
  version: 1,
  createdAt: '2026-11-19T04:00:00.000Z',
};

const ACTIONS: Record<SampleAction, { summary: string; description: string; example: object }> = {
  collect: {
    summary: 'Mark sample collected',
    description: 'PENDING → COLLECTED (collection time + collector). W16.03 "Collected".',
    example: { expectedVersion: 0, at: '2026-11-19T04:00:00.000Z' },
  },
  send: {
    summary: 'Send for testing',
    description:
      'COLLECTED → SENT. Sets the expected result date (sent + lab turnaround days). W16.03 button.',
    example: { expectedVersion: 1 },
  },
  'lab-status': {
    summary: 'Lab progress (manual)',
    description:
      "Forward only: SENT → ACKNOWLEDGED → TESTING → RESULTS_RECEIVED. W16.04 steps. `labRef` = the lab's reference (e.g. IFN-26-08455).",
    example: { expectedVersion: 2, status: 'ACKNOWLEDGED', labRef: 'IFN-26-08455' },
  },
  flag: {
    summary: 'Flag issue',
    description:
      'Adds a note to the timeline and audit (no status change). Linking to W15 exceptions is Future.',
    example: { expectedVersion: 2, note: 'Seal on sample bag 2 was broken' },
  },
  cancel: {
    summary: 'Cancel sample',
    description: 'Before results only. Reason required.',
    example: { expectedVersion: 1, note: 'Wrong batch picked; new sample raised' },
  },
};

export const samplesDocs = (aud: Audience) => {
  const tag = tagOf(aud, SAMPLES_AREA);
  const auth = AUTH_STAFF(aud);
  const action = (a: SampleAction): RouteDocs => ({
    tag,
    summary: ACTIONS[a].summary,
    description: `${ACTIONS[a].description} Optimistic lock: send the sample \`version\` as \`expectedVersion\` (409 VERSION_CONFLICT when someone else moved it first).`,
    auth,
    permission: 'quality.hold_create',
    errors: [400, 404, 409],
    requestExample: ACTIONS[a].example,
    errorExamples: {
      409: [
        VERSION_CONFLICT,
        {
          summary: 'Wrong step',
          message: 'Cannot send a pending sample',
          details: { reason: 'INVALID_TRANSITION' },
        },
      ],
    },
    success: {
      status: 200,
      description: 'Moved',
      example: {
        success: true,
        data: {
          id: IDS.sample,
          sampleNo: 'SMP-2026-0048',
          status: 'COLLECTED',
          version: 1,
          steps: [],
        },
      },
    },
  });
  return {
    action,
    summary: {
      tag,
      summary: 'Sampling dashboard cards',
      description:
        "W16.01: Pending samples · Testing in progress · Passed · Failed (+ cancelled), in the caller's warehouses.",
      auth,
      permission: 'quality.view',
      errors: [404],
      success: {
        status: 200,
        description: 'Counts',
        example: {
          success: true,
          data: { pending: 12, testing: 6, passed: 24, failed: 2, cancelled: 0 },
        },
      },
    } satisfies RouteDocs,
    list: {
      tag,
      summary: 'Samples',
      description:
        'W16.01 table (Sample ID · Batch · Laboratory · Status). `q` matches sample no, batch no or CN.',
      auth,
      permission: 'quality.view',
      success: {
        status: 200,
        description: 'Samples',
        paginated: true,
        example: { success: true, data: [ROW], meta: { nextCursor: null, limit: 20 } },
      },
    } satisfies RouteDocs,
    create: {
      tag,
      summary: 'Create sample request',
      description:
        "W16.02: SKU (from the batch) · Batch · Consignment · Sample quantity · Laboratory (default = the SKU spec's lab). The batch must have been received at the warehouse (under `cnNo` when given).",
      auth,
      permission: 'quality.hold_create',
      errors: [400, 404, 409],
      requestExample: {
        batchId: IDS.batch,
        warehouseId: IDS.warehouse,
        cnNo: 'CN-2026-0048',
        qty: 3,
        labId: IDS.lab,
      },
      success: {
        status: 201,
        description: 'Created',
        example: {
          success: true,
          data: { id: IDS.sample, sampleNo: 'SMP-2026-0048', status: 'PENDING', version: 0 },
        },
      },
    } satisfies RouteDocs,
    get: {
      tag,
      summary: 'Sample details + lab test status',
      description:
        'W16.03 / W16.04: sample, collection, lab, 4 lab steps, independent COA (if any), timeline and the actions allowed now.',
      auth,
      permission: 'quality.view',
      errors: [404],
      success: {
        status: 200,
        description: 'Sample',
        example: {
          success: true,
          data: {
            ...ROW,
            receiptId: IDS.receipt,
            collectedAt: '2026-11-19T04:00:00.000Z',
            collectedBy: IDS.user,
            sentAt: null,
            acknowledgedAt: null,
            testingAt: null,
            resultsAt: null,
            closedAt: null,
            steps: [
              { no: '01', key: 'COLLECTED', label: 'Sample collected', state: 'COMPLETED' },
              { no: '02', key: 'ACKNOWLEDGED', label: 'Laboratory acknowledged', state: 'CURRENT' },
              { no: '03', key: 'TESTING', label: 'Tests in progress', state: 'PENDING' },
              { no: '04', key: 'RESULTS_RECEIVED', label: 'Results received', state: 'PENDING' },
            ],
            coa: null,
            timeline: [
              {
                at: '2026-11-19T04:00:00.000Z',
                type: 'COLLECT',
                fromStatus: 'PENDING',
                toStatus: 'COLLECTED',
                note: null,
                actorUserId: IDS.user,
              },
            ],
            actions: ['send', 'flag', 'cancel'],
          },
        },
      },
    } satisfies RouteDocs,
  };
};
