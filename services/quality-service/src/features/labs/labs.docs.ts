import type { RouteDocs } from '@farmx/common/server';

import { AUTH_GLOBAL, AUTH_STAFF, IDS, VERSION_CONFLICT, tagOf } from '../../docs/shared.js';
import type { Audience } from '../../middleware/guards.js';

export const LABS_AREA = 'Labs (W16.08)';

const CONNECTOR = {
  mode: 'MANUAL',
  status: 'NOT_AVAILABLE',
  lastSyncAt: null,
  note: 'Results are entered by QA. A LIMS connection (API / webhook / auto sync) is planned.',
};

const LAB = {
  id: IDS.lab,
  code: 'FXQA',
  name: 'FarmX QA Lab',
  accreditation: 'NABL ISO 17025',
  type: 'IN_HOUSE',
  tatDays: 5,
  contactName: 'QA Desk',
  contactPhone: '+919000000000',
  contactEmail: 'qa@farmx.in',
  address: 'Mother WH, Eluru',
  status: 'ACTIVE',
  version: 0,
  connector: CONNECTOR,
  latestSample: { sampleNo: 'SMP-2026-0048', at: '2026-11-19T04:00:00.000Z' },
  updatedAt: '2026-11-19T05:00:00.000Z',
};

export const labsDocs = (aud: Audience) => {
  const tag = tagOf(aud, LABS_AREA);
  const auth = AUTH_STAFF(aud);
  return {
    list: {
      tag,
      summary: 'Laboratories',
      description:
        'W16.08 Lab Integration: labs with accreditation, turnaround and the latest sample sent ("Sample mapping"). `connector.status` is NOT_AVAILABLE: results are entered manually (LIMS is Future).',
      auth,
      permission: 'quality.view',
      success: { status: 200, description: 'Labs', example: { success: true, data: [LAB] } },
    },
    get: {
      tag,
      summary: 'One laboratory',
      auth,
      permission: 'quality.view',
      errors: [404],
      success: { status: 200, description: 'Lab', example: { success: true, data: LAB } },
    },
    create: {
      tag,
      summary: 'Add a laboratory',
      auth: AUTH_GLOBAL,
      permission: 'quality.lab_manage',
      errors: [400, 409],
      requestExample: {
        code: 'IFN',
        name: 'Interferon Labs',
        accreditation: 'NABL ISO 17025',
        type: 'EXTERNAL',
        tatDays: 6,
      },
      errorExamples: {
        409: { message: 'Lab code IFN is already used', details: { reason: 'CODE_TAKEN' } },
      },
      success: { status: 201, description: 'Created', example: { success: true, data: LAB } },
    },
    update: {
      tag,
      summary: 'Edit a laboratory (optimistic lock)',
      description:
        'Send the `version` you read as `expectedVersion`; a stale one answers 409 VERSION_CONFLICT.',
      auth: AUTH_GLOBAL,
      permission: 'quality.lab_manage',
      errors: [400, 404, 409],
      requestExample: { tatDays: 4, expectedVersion: 0 },
      errorExamples: { 409: VERSION_CONFLICT },
      success: {
        status: 200,
        description: 'Updated',
        example: { success: true, data: { ...LAB, version: 1 } },
      },
    },
    testConnection: {
      tag,
      summary: 'Test lab connection',
      description:
        'W16.08 button. Manual labs only for now: always answers `status: NOT_AVAILABLE`.',
      auth,
      permission: 'quality.view',
      errors: [404],
      success: {
        status: 200,
        description: 'Connector state',
        example: { success: true, data: { labId: IDS.lab, ...CONNECTOR } },
      },
    },
  } satisfies Record<string, RouteDocs>;
};
