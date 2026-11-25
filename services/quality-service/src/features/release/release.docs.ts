import type { RouteDocs } from '@farmx/common/server';

import { AUTH_STAFF, IDEMPOTENCY_HEADER, IDS, VERSION_CONFLICT, tagOf } from '../../docs/shared.js';
import type { Audience } from '../../middleware/guards.js';

export const RELEASE_AREA = 'Quality release (W16.07)';

const DECISION = {
  id: IDS.decision,
  decisionNo: 'QD-2026-0007',
  batchId: IDS.batch,
  kind: 'RELEASE',
  status: 'PARTIAL',
  remarks: 'COA verified against spec v2; batch and QR matched',
  checklist: { mode: 'MANUFACTURER_COA', items: [], blockers: [] },
  coaIds: [IDS.coa],
  stateVersion: 3,
  decidedBy: IDS.user,
  decidedAt: '2026-11-25T10:00:00.000Z',
  plannedAt: '2026-11-25T10:00:02.000Z',
  completedAt: '2026-11-25T10:06:00.000Z',
  stuck: false,
  progress: { total: 2, done: 1, failed: 1, pending: 0 },
  tasks: [
    {
      warehouseId: IDS.warehouse,
      status: 'DONE',
      qtyMoved: 120,
      attempts: 1,
      lastError: null,
      updatedAt: '2026-11-25T10:00:05.000Z',
    },
    {
      warehouseId: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8b0a',
      status: 'FAILED',
      qtyMoved: 0,
      attempts: 6,
      lastError: 'warehouse inactive',
      updatedAt: '2026-11-25T10:06:00.000Z',
    },
  ],
  evidence: [],
};

export const releaseDocs = (aud: Audience) => {
  const tag = tagOf(aud, RELEASE_AREA);
  const auth = AUTH_STAFF(aud);
  return {
    releaseCheck: {
      tag,
      summary: 'Release checklist',
      description:
        'W16.07: QA HOLD banner, the 4 checks (COA verified · Approved SKU specification checked · Batch and QR matched · Authorized QA approval), blockers and the batch-state `version` to send as `expectedVersion`. The release mode of the SKU decides which COA counts: MANUFACTURER_COA (approved manufacturer or independent PASS) or INDEPENDENT_COA (approved independent PASS only).',
      auth,
      permission: 'quality.view',
      errors: [404],
      success: {
        status: 200,
        description: 'Checklist',
        example: {
          success: true,
          data: {
            batchId: IDS.batch,
            batchNo: 'B2408',
            product: {
              variantId: IDS.variant,
              sku: 'ND-LASOTA',
              name: 'ND LaSota vaccine',
              variantName: '1000 doses',
            },
            state: 'PENDING',
            version: 2,
            releaseMode: 'MANUFACTURER_COA',
            banner: {
              code: 'QA_HOLD',
              text: 'Stock remains unavailable until authorized release.',
            },
            checklist: [
              {
                key: 'COA_VERIFIED',
                label: 'COA verified',
                state: 'REVIEWED',
                detail: 'COA-2026-0048 (manufacturer) · PASS',
              },
              {
                key: 'SPEC_CHECKED',
                label: 'Approved SKU specification checked',
                state: 'REVIEWED',
                detail: 'Spec version 2',
              },
              {
                key: 'BATCH_QR_MATCHED',
                label: 'Batch and QR matched',
                state: 'REVIEWED',
                detail: null,
              },
              {
                key: 'QA_APPROVAL',
                label: 'Authorized QA approval required',
                state: 'PENDING',
                detail: null,
              },
            ],
            canRelease: true,
            blockers: [],
            lastDecision: null,
          },
        },
      },
    } satisfies RouteDocs,
    decide: {
      tag,
      summary: 'Submit release decision / Quarantine batch / Recall',
      description: [
        'W16.07 buttons. One transaction: batch-state version check, decision, audit and outbox (`quality.decision_requested.v1`, `quality.batch_state_changed.v1`, and for RECALL `quality.batch_recalled.v1` to every buyer).',
        'warehouse-service then moves the stock in **every warehouse holding the batch**, one task (own transaction) per warehouse: RELEASE = QC_HOLD → AVAILABLE; QUARANTINE / RECALL = QC_HOLD + AVAILABLE → QUARANTINED. Follow progress with `GET /decisions/:id` (APPLYING → APPLIED, or PARTIAL / FAILED with per-warehouse errors; retry with `POST /decisions/:id/retry`).',
        'Permissions by kind: RELEASE `quality.hold_release` (GLOBAL), QUARANTINE `quality.hold_create`, RECALL `quality.recall_initiate` (GLOBAL).',
        'Concurrency: two people deciding on the same `version` → one wins, the other gets 409 VERSION_CONFLICT with who decided.',
      ].join('\n\n'),
      auth,
      permission: 'quality.hold_release | quality.hold_create | quality.recall_initiate (by kind)',
      headers: IDEMPOTENCY_HEADER,
      errors: [400, 404, 409],
      requestExample: {
        kind: 'RELEASE',
        remarks: 'COA verified against spec v2; batch and QR matched',
        expectedVersion: 2,
      },
      errorExamples: {
        409: [
          {
            ...VERSION_CONFLICT,
            details: {
              reason: 'VERSION_CONFLICT',
              currentVersion: 3,
              lastDecision: {
                decisionNo: 'QD-2026-0007',
                kind: 'RELEASE',
                decidedBy: IDS.user,
                decidedAt: '2026-11-25T10:00:00.000Z',
              },
            },
          },
          {
            summary: 'Checklist not complete',
            message: 'This batch cannot be released yet',
            details: {
              reason: 'RELEASE_BLOCKED',
              blockers: ['COA verified: Waiting for an approved COA'],
            },
          },
          {
            summary: 'Recalled',
            message: 'This batch is recalled; no further decision is possible',
            details: { reason: 'ALREADY_RECALLED' },
          },
          {
            summary: 'Release still applying',
            message: 'A release of this batch is still being applied; wait for it to finish',
            details: { reason: 'RELEASE_IN_PROGRESS' },
          },
        ],
      },
      success: {
        status: 201,
        description: 'Decision recorded (stock moves follow)',
        example: {
          success: true,
          data: {
            ...DECISION,
            status: 'APPLYING',
            plannedAt: null,
            completedAt: null,
            progress: { total: null, done: 0, failed: 0, pending: 0 },
            tasks: [],
          },
        },
      },
    } satisfies RouteDocs,
    list: {
      tag,
      summary: 'Decision history of a batch',
      auth,
      permission: 'quality.view',
      success: {
        status: 200,
        description: 'Decisions (newest first)',
        example: { success: true, data: [DECISION] },
      },
    } satisfies RouteDocs,
    get: {
      tag,
      summary: 'Decision progress (per warehouse)',
      description:
        '`stuck` = still APPLYING after DECISION_STUCK_MINUTES. Evidence files come as 5-minute signed URLs.',
      auth,
      permission: 'quality.view',
      errors: [404],
      success: { status: 200, description: 'Decision', example: { success: true, data: DECISION } },
    } satisfies RouteDocs,
    retry: {
      tag,
      summary: 'Retry failed warehouses',
      description:
        'Re-queues only the FAILED warehouse tasks with the same task keys, so a warehouse that already moved its stock is never moved twice.',
      auth,
      permission: 'same as the decision kind',
      errors: [404, 409],
      errorExamples: {
        409: {
          message: 'No warehouse of this decision has failed',
          details: { reason: 'NOTHING_TO_RETRY' },
        },
      },
      success: {
        status: 200,
        description: 'Re-queued',
        example: { success: true, data: { ...DECISION, status: 'APPLYING' } },
      },
    } satisfies RouteDocs,
  };
};
