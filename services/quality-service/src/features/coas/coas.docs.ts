import type { RouteDocs } from '@farmx/common/server';

import { AUTH_GLOBAL, AUTH_STAFF, IDS, VERSION_CONFLICT, tagOf } from '../../docs/shared.js';
import type { Audience } from '../../middleware/guards.js';

export const COAS_AREA = 'Certificates of analysis (W16.05 / W16.06 / W16.10)';

const COA = {
  id: IDS.coa,
  coaNo: 'COA-2026-0048',
  source: 'INDEPENDENT',
  status: 'RESULTS_ENTERED',
  verdict: 'PENDING',
  version: 1,
  certificateRef: 'IFN-26-08455',
  batchNoOnDocument: null,
  batch: {
    batchId: IDS.batch,
    batchNo: 'B2408',
    mfgDate: '2026-06-01',
    expiryDate: '2027-03-31',
    serialized: true,
  },
  product: {
    variantId: IDS.variant,
    sku: 'ND-LASOTA',
    name: 'ND LaSota vaccine',
    variantName: '1000 doses',
    brandName: 'Godavari Biologicals',
  },
  sample: {
    id: IDS.sample,
    sampleNo: 'SMP-2026-0048',
    status: 'RESULTS_RECEIVED',
    labRef: 'IFN-26-08455',
  },
  lab: { id: IDS.lab, name: 'FarmX QA Lab', accreditation: 'NABL ISO 17025' },
  issuerName: 'FarmX QA Lab',
  analystName: 'K. Divya',
  signatoryName: 'Dr. M. Harsha',
  issuedAt: '2026-11-20',
  validUntil: '2027-11-20',
  validity: { state: 'PENDING_QA', text: 'Pending QA verification' },
  qrMapping: {
    serialized: true,
    unitsReceived: 8,
    text: 'Unit QR codes of batch B2408 (8 units received)',
  },
  mapping: { confirmed: true, confirmedBy: null, confirmedAt: null, candidates: [] },
  document: { url: 'https://media.farmx.in/signed/…' },
  results: [
    {
      paramCode: 'IDENTITY',
      paramName: 'Identity',
      unit: null,
      rule: 'TEXT',
      specLabel: 'Conforms',
      valueNum: null,
      valueText: 'Conforms',
      value: 'Conforms',
      verdict: 'CONFORMS',
      critical: true,
    },
    {
      paramCode: 'POTENCY',
      paramName: 'Potency (virus titre, log10)',
      unit: 'log10 EID50',
      rule: 'MIN',
      specLabel: '≥ 6 log10 EID50',
      valueNum: 6.4,
      valueText: null,
      value: '6.4 log10 EID50',
      verdict: 'CONFORMS',
      critical: true,
    },
    {
      paramCode: 'STERILITY',
      paramName: 'Sterility',
      unit: null,
      rule: 'TEXT',
      specLabel: 'Pass',
      valueNum: null,
      valueText: null,
      value: 'Pending review',
      verdict: 'REVIEW',
      critical: true,
    },
  ],
  summary: { conforms: 2, fails: 0, review: 1 },
  entered: { by: IDS.user, at: '2026-11-20T09:00:00.000Z' },
  signature: { state: 'PENDING', reviewedBy: null, reviewedAt: null, note: null },
  publishedAt: null,
  mismatch: null,
  note: 'Acceptance limits require approved SKU-specific specifications.',
  actions: ['approve', 'reject'],
};

export const coasDocs = (aud: Audience) => {
  const tag = tagOf(aud, COAS_AREA);
  const auth = AUTH_STAFF(aud);
  return {
    list: {
      tag,
      summary: 'Certificates',
      description:
        'W16.10 list. `expiringWithinDays` = approved certificates whose validity ends soon (validity tracking). `q` matches COA no or the batch no on the document.',
      auth,
      permission: 'quality.view',
      success: {
        status: 200,
        description: 'Certificates',
        paginated: true,
        example: {
          success: true,
          data: [
            {
              id: IDS.coa,
              coaNo: 'COA-2026-0048',
              source: 'MANUFACTURER',
              status: 'LINKED',
              verdict: 'PENDING',
              batchId: IDS.batch,
              batchNo: 'B2408',
              issuerName: 'Godavari Biologicals QC',
              issuedAt: '2026-06-02',
              validUntil: '2027-06-02',
              validity: { state: 'PENDING_QA', text: 'Pending QA verification' },
              version: 0,
            },
          ],
          meta: { nextCursor: null, limit: 20 },
        },
      },
    } satisfies RouteDocs,
    get: {
      tag,
      summary: 'COA review / certificate details',
      description:
        'W16.05 (parameter · specification · result · status Conforms / Fails / Review) and W16.06 (certificate no, PDF as a 5-minute signed URL, batch, sample, QR mapping, validity, signature state). `mismatch` = manufacturer said CONFORMS where the independent lab found FAILS (Certificate Audit Alert; HIGH when a critical parameter is involved).',
      auth,
      permission: 'quality.view',
      errors: [404],
      success: { status: 200, description: 'Certificate', example: { success: true, data: COA } },
    } satisfies RouteDocs,
    upload: {
      tag,
      summary: 'Upload manufacturer COA (auto-link)',
      description:
        "W16.10. Upload the PDF to media-service first (`purpose=wms_document`) and send its receipt. The batch number on the document is matched to received batches (narrowed by `variantId` / `cnNo`): one match → LINKED (confirm with confirm-mapping), none or several → UPLOADED with `mapping.candidates`. valid-until defaults to issuedAt + the SKU's coaValidityDays.",
      auth,
      permission: 'traceability.coa_publish',
      errors: [400, 403],
      requestExample: {
        receipt: 'eyJwdXJwb3NlIjoid21zX2RvY3VtZW50In0.c2ln',
        batchNo: 'B2408',
        cnNo: 'CN-2026-0048',
        issuerName: 'Godavari Biologicals QC',
        signatoryName: 'QC Head',
        issuedAt: '2026-06-02',
      },
      success: {
        status: 201,
        description: 'Uploaded',
        example: {
          success: true,
          data: {
            ...COA,
            source: 'MANUFACTURER',
            status: 'LINKED',
            mapping: { confirmed: false, confirmedBy: null, confirmedAt: null, candidates: [] },
          },
        },
      },
    } satisfies RouteDocs,
    confirmMapping: {
      tag,
      summary: 'Confirm COA mapping',
      description:
        'W16.10 button: a person confirms certificate → batch → unit QR mapping (or picks the batch among candidates). The batch number on the document must match.',
      auth,
      permission: 'traceability.coa_publish',
      errors: [400, 404, 409],
      errorExamples: {
        409: [
          VERSION_CONFLICT,
          {
            summary: 'Wrong batch',
            message: 'The certificate is for batch B2408, not B2409',
            details: { reason: 'BATCH_MISMATCH' },
          },
        ],
      },
      success: { status: 200, description: 'Mapped', example: { success: true, data: COA } },
    } satisfies RouteDocs,
    results: {
      tag,
      summary: 'Enter manufacturer COA results',
      description:
        'Values as printed on the manufacturer certificate. Every SKU parameter gets a row (missing → REVIEW); each is judged against the current spec and keeps that limit. Status → RESULTS_ENTERED; another person approves.',
      auth,
      permission: 'traceability.coa_publish',
      errors: [400, 404, 409],
      requestExample: {
        results: [
          { paramCode: 'MOISTURE', valueNum: 9.4 },
          { paramCode: 'AFB1_BINDING', valueNum: 92 },
        ],
        expectedVersion: 1,
      },
      errorExamples: {
        409: [
          VERSION_CONFLICT,
          {
            summary: 'No spec',
            message: 'Set the SKU specification limits first (W16.09)',
            details: { reason: 'SPEC_MISSING' },
          },
        ],
      },
      success: { status: 200, description: 'Entered', example: { success: true, data: COA } },
    } satisfies RouteDocs,
    sampleResults: {
      tag,
      summary: 'Enter independent lab results of a sample',
      description:
        'Manual result entry (LIMS is Future). One transaction: sample → RESULTS_RECEIVED (optimistic lock on the SAMPLE version), the independent COA is created on first entry, all results judged against the spec, audit. Optional lab report PDF receipt. A different person reviews.',
      auth,
      permission: 'traceability.coa_publish',
      errors: [400, 404, 409],
      requestExample: {
        results: [
          { paramCode: 'IDENTITY', valueText: 'Conforms' },
          { paramCode: 'POTENCY', valueNum: 5.8 },
          { paramCode: 'STERILITY', valueText: 'Pass' },
        ],
        expectedVersion: 4,
        certificateRef: 'IFN-26-08455',
        analystName: 'K. Divya',
        signatoryName: 'Dr. M. Harsha',
        issuedAt: '2026-09-20',
      },
      errorExamples: { 409: VERSION_CONFLICT },
      success: {
        status: 200,
        description: 'Independent COA',
        example: { success: true, data: COA },
      },
    } satisfies RouteDocs,
    review: {
      tag,
      summary: 'Review certificate (approve / reject)',
      description: [
        'W16.05 "Review certificate". **Four-eyes:** the person who entered the results cannot review them (409 SAME_PERSON). APPROVE needs every parameter judged (409 RESULTS_INCOMPLETE).',
        'Independent COA approved → published to customers (`quality.coa_published.v1` to watchers), sample PASSED / FAILED; a FAIL **recalls the batch in the same transaction** (quarantine in every warehouse + every buyer notified).',
        'REJECT: manufacturer COA → REJECTED (upload a new one); independent COA → sent back to the lab (sample → TESTING, results can be entered again).',
      ].join('\n\n'),
      auth: AUTH_GLOBAL,
      permission: 'traceability.coa_verify',
      errors: [400, 404, 409],
      requestExample: {
        decision: 'APPROVE',
        note: 'All parameters within limits',
        expectedVersion: 1,
      },
      errorExamples: {
        409: [
          VERSION_CONFLICT,
          {
            summary: 'Same person',
            message:
              'The person who entered the results cannot approve them; ask another QA approver',
            details: { reason: 'SAME_PERSON' },
          },
          {
            summary: 'Incomplete',
            message: 'Some parameters still need a result',
            details: { reason: 'RESULTS_INCOMPLETE', params: ['Sterility'] },
          },
        ],
      },
      success: {
        status: 200,
        description: 'Reviewed',
        example: {
          success: true,
          data: {
            ...COA,
            status: 'APPROVED',
            verdict: 'PASS',
            signature: {
              state: 'SIGNED',
              reviewedBy: IDS.user,
              reviewedAt: '2026-11-21T09:00:00.000Z',
              note: 'All parameters within limits',
            },
          },
        },
      },
    } satisfies RouteDocs,
  };
};
