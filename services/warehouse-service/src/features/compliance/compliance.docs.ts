import Joi from 'joi';

import { IF_VERSION, wmsDoc } from '../../docs/shared.js';
import { PAGE_META } from '../../middleware/paging.js';

export const COMPLIANCE_AREA = 'Compliance check';

const any = Joi.object().unknown(true);
const SOD = 'GLOBAL compliance.review; never the person who uploaded the document.';

export const complianceDocs = (aud: 'panel' | 'admin') => {
  const d = (s: string, p: string, o: Parameters<typeof wmsDoc>[4] = {}) =>
    wmsDoc(aud, COMPLIANCE_AREA, s, p, o);
  return {
    kpis: d('Compliance tab counts + KPI chips', 'fulfilment.view', {
      data: any,
      description:
        'Pending (incl. flagged), flagged, on hold, approved, rejected; auto-audit SLA (avg created → decided, 30 days). State portal / OCR / WhatsApp are `modules` flags (not integrated).',
    }),
    cases: d('Compliance cases', 'fulfilment.view', {
      paginated: true,
      data: Joi.array().items(any),
      meta: PAGE_META,
      description:
        'Card: case no, order, customer, "4 SKUs (2 Restricted)", value, chip (ACTIVE CHECK / RX VERIFIED / PERMIT EXPIRED), SLA, escalation level.',
    }),
    case: d('Case detail (checklist, inspector, notes, documents)', 'fulfilment.view', {
      data: any,
      description:
        'Gate label, customer account code, dispatch cut-off; mandatory checks with legal basis, document no, issuer, validity, verification method, qty label and signed document URLs; inspector; notes; evidence; waivers; whether it can be approved.',
    }),
    ledger: d('Restricted drug ledger', 'fulfilment.view', {
      data: any,
      description:
        "Restricted lines with the proposed FEFO lot and the customer's 30-day totals. Secure zones arrive with the D-56 zone flag (`modules.secureZones`).",
    }),
    evidence: d('Case evidence', 'fulfilment.view', { data: Joi.array().items(any) }),
    document: d('Attach a document to a check', 'fulfilment.manage', {
      data: any,
      errors: [404, 409, 422],
      description:
        'Media receipt (purpose `wms_document`) from media-service; a rejected check goes back to pending.',
    }),
    addEvidence: d('Add extra evidence (scan slip, declaration)', 'fulfilment.manage', {
      status: 201,
      data: Joi.array().items(any),
      errors: [404, 409, 422],
    }),
    checkDecision: d('Verify / reject one check', 'compliance.review', {
      data: any,
      errors: [404, 409, 422],
      description: `${SOD} Reject needs a reason.`,
    }),
    inspector: d('Assign inspector', 'fulfilment.manage', { data: any, errors: [404, 409, 422] }),
    note: d('Add a note', 'fulfilment.view', {
      status: 201,
      data: Joi.array().items(any),
      errors: [404, 422],
    }),
    request: d('Request a document from the customer', 'fulfilment.manage', {
      data: any,
      errors: [404, 409],
      description: 'SMS / in-app today; WhatsApp falls back to SMS until integrated.',
    }),
    decision: d('Approve & release / Hold / Reject', 'compliance.review', {
      data: any,
      errors: [404, 409, 422],
      description: `Approve needs every check verified or waived → FEFO allocation allowed. Reject (reason; not by an uploader) asks order-service to reject (before admin confirmation) or cancel + refund (after); the stock release frees the lots. ${IF_VERSION}`,
    }),
    waiver: d('Waive checks (Form 19)', 'compliance.review', {
      data: any,
      errors: [404, 409, 422],
      description:
        "GLOBAL compliance.review + the reviewer's current TOTP code (step-up; 5 wrong codes → locked 15 min); authorization no + optional receipt; audited.",
    }),
    registry: d('Regulatory registry', 'fulfilment.view', { data: Joi.array().items(any) }),
    ruleSave: d('Save a registry rule', 'compliance.review', { data: any, errors: [422] }),
    inspectors: d('Inspectors', 'fulfilment.view', { data: Joi.array().items(any) }),
    inspectorSave: d('Save an inspector', 'compliance.review', { data: any, errors: [422] }),
    auditCsv: d('Export compliance audit log (CSV)', 'fulfilment.view', {
      description: 'Cases with decisions; streamed, CSV-injection safe. 5 per minute.',
    }),
  };
};
