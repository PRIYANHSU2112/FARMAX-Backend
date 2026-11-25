import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { IF_VERSION, wmsDoc } from '../../docs/shared.js';
import { PAGE_META } from '../../middleware/paging.js';

export const DELIVERY_AREA = 'Delivery & settlement';
export const DRIVER_TAG = 'WMS · Driver (3PL link)';
export const CUSTOMER_TAG = 'WMS · Customer shipments';

const any = Joi.object().unknown(true);
const list = Joi.array().items(any);
const OTP_RULES =
  'OTP rules (D-40): 6 digits, 12 h, 5 tries (then 423 OTP_LOCKED), expired → 410 OTP_EXPIRED, wrong → 422; never shown to staff, never in logs or events.';
const PAGED = 'Keyset `cursor` or numbered `page` (offset ≤ 2,000; total exact up to 10,000).';

export const deliveryDocs = (aud: 'panel' | 'admin') => {
  const d = (s: string, p: string, o: Parameters<typeof wmsDoc>[4] = {}) =>
    wmsDoc(aud, DELIVERY_AREA, s, p, o);
  return {
    out: d('Out for delivery (issue OTP)', 'logistics.dispatch_assign', {
      data: any,
      errors: [404, 409],
      description: `DISPATCHED / DELIVERY_FAILED → OUT_FOR_DELIVERY; a new code appears in the customer app only. ${OTP_RULES}`,
    }),
    deliver: d('Deliver with OTP + POD', 'logistics.delivery_confirm', {
      data: any,
      errors: [404, 409, 422],
      description: `Customer OTP + receiver name + received quantities (default all) + POD photos / signature (media receipts, purpose wms_document). Short delivery → settlement DISCREPANCY. ${OTP_RULES}`,
    }),
    override: d('Deliver without OTP (override)', 'logistics.delivery_override', {
      data: any,
      errors: [404, 409, 422],
      description:
        'Reason required; settlement stays PENDING (OTP_LOCK) until a different person approves in W3.10.',
    }),
    failed: d('Delivery failed', 'logistics.delivery_confirm', {
      data: any,
      errors: [404, 409, 422],
      description:
        'Reason; DELIVERY exception; reattempt via out-for-delivery (new code) or return to warehouse.',
    }),
    resend: d('Send a new delivery code', 'logistics.dispatch_assign', {
      data: any,
      errors: [404, 409],
      description:
        'Cooldown 60 s, at most 5 resends (409 OTP_COOLDOWN / OTP_RESEND_LIMIT). The code shows in the customer app.',
    }),
    returned: d('Return to warehouse', 'inventory.receive', {
      data: any,
      errors: [404, 409, 422],
      description: 'Failed delivery comes back: units land in RETURNED (inspection then restocks).',
    }),
    fulfil: d('Confirm final quantities (fulfil)', 'fulfilment.manage', {
      data: any,
      errors: [404, 409],
      description:
        'DELIVERED → FULFILLED with settlement SETTLED or PENDING (OTP_LOCK > DISCREPANCY > POD_MISSING).',
    }),
    settle: d('Settle now (prepaid reconciliation)', 'fulfilment.manage', {
      data: any,
      errors: [404, 409, 422],
      description: `REFUND_SHORTAGE (order-service refunds the undelivered units, idempotent per shipment) · CONFIRM_FULL (driver mis-entry) · ATTACH_POD (receipts) · APPROVE_OVERRIDE (logistics.delivery_override, not the person who overrode). Credit / COD settlement is a later phase. ${IF_VERSION}`,
    }),
    pod: d('View POD', 'fulfilment.view', {
      data: any,
      description:
        'Signed POD photos / signature, received quantities, weigh slip, location, OTP verified time (never the code), override details.',
    }),
    deliveredKpis: d('Delivered KPIs', 'fulfilment.view', {
      data: any,
      description:
        'Delivered, on-time delivery %, POD %, OTP % (not override), failed, returned (default last 30 days).',
    }),
    delivered: d('Delivered orders (W3.09)', 'fulfilment.view', {
      paginated: true,
      data: list,
      meta: PAGE_META,
      description: `Status filter DELIVERED · DELIVERY_FAILED · RETURNED_TO_WAREHOUSE; OTP column = "Verified ✓ + time" only. ${PAGED}`,
    }),
    fulfilledKpis: d('Fulfilled KPIs + tabs (W3.10)', 'fulfilment.view', {
      data: any,
      description:
        'Settled / pending count + value, overdue (pending > settleOverdueDays), average hours to settle. Credit parts → `modules.credit=false`.',
    }),
    fulfilled: d('Fulfilled orders (W3.10)', 'fulfilment.view', {
      paginated: true,
      data: list,
      meta: PAGE_META,
      description: `Tabs all · settled · pending · overdue; valuation "UPI · Paid in advance"; final qty (units, tonnes); settlement label. ${PAGED}`,
    }),
    exportCreate: d('Request an export (POD archive / CSV)', 'fulfilment.view', {
      status: 201,
      data: any,
      errors: [422],
      description:
        'Async: POD_ARCHIVE (selected shipments or filters), DELIVERED_CSV, FULFILLED_CSV (≤ 50k rows).',
    }),
    exports: d('My exports', 'fulfilment.view', { paginated: true, data: list }),
    exportGet: d('Export status', 'fulfilment.view', { data: any }),
    exportDownload: d('Download export (CSV)', 'fulfilment.view', {
      description: 'POD links are signed at download time (valid 5 minutes).',
    }),
    invoicePdf: d('Print the shipment’s GST invoice (PDF)', 'fulfilment.view', {
      errors: [404, 503],
      description:
        'Returns **`application/pdf`** (attachment), not JSON: the active tax invoice of THIS shipment (issued at gate-out, D-61) for the copy that travels with the goods. A shipment outside your warehouses answers 404 like a missing one; before gate-out → 404 `NO_INVOICE`. Never waits for the background renderer. Audited. 30 per user per minute.',
    }),
    linkCreate: d('Create 3PL driver trip link', 'logistics.dispatch_assign', {
      status: 201,
      data: any,
      errors: [404, 409, 422],
      description:
        'Random token (returned once, stored hashed), this trip only, until completion + 12 h (max 48 h); a new link revokes the old one.',
    }),
    linkRevoke: d('Revoke driver trip link', 'logistics.dispatch_assign', {
      data: any,
      errors: [404],
    }),
  };
};

const pub = (
  tag: string,
  summary: string,
  description: string,
  o: { data?: Joi.Schema; status?: number; errors?: number[] } = {},
): RouteDocs =>
  ({
    tag,
    summary,
    description,
    auth:
      tag === DRIVER_TAG
        ? 'Public: the trip link token in the path is the credential.'
        : 'Bearer access token of a CUSTOMER.',
    success: {
      status: o.status ?? 200,
      description: summary,
      ...(o.data === undefined ? {} : { data: o.data }),
    },
    errors: (o.errors ?? [404, 410, 422]) as never,
  }) as RouteDocs;

export const publicDocs = {
  driverTrip: pub(
    DRIVER_TAG,
    'Driver: trip stops and drops',
    'Stops, drops (shipment, units, destination). 404 unknown link; 410 expired / revoked.',
    { data: any },
  ),
  driverPing: pub(
    DRIVER_TAG,
    'Driver: send position',
    'Stored at most once per 30 s per trip; 60 per minute.',
    { data: any },
  ),
  driverOut: pub(DRIVER_TAG, 'Driver: out for delivery', 'The customer app shows the new code.', {
    data: any,
  }),
  driverDeliver: pub(
    DRIVER_TAG,
    'Driver: deliver with the customer OTP',
    `${OTP_RULES} POD photos are added later by staff (settlement POD_MISSING).`,
    { data: any, errors: [404, 409, 410, 422, 423] },
  ),
  driverFailed: pub(DRIVER_TAG, 'Driver: delivery failed', 'Reason required.', { data: any }),
  customer: pub(
    CUSTOMER_TAG,
    'My shipments',
    'Own orders only: status, ETA, tracking position; `deliveryOtp` only while out for delivery.',
    { data: list, errors: [401, 403, 422] },
  ),
};
