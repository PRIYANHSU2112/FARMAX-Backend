import type { RouteDocs } from '@farmx/common/server';

import { AUTH_CUSTOMER, AUTH_PUBLIC, CUSTOMER_TAG, IDS, PUBLIC_TAG } from '../../docs/shared.js';

const PRIVACY =
  'No buyer or farm details are shown here. Only the goods, batch, source certificate and verdict are public.';

const CARD = {
  batchId: IDS.batch,
  batchNo: 'TB-0926',
  mfgDate: '2026-08-01',
  expiryDate: '2027-07-31',
  vendorName: 'Sri Venkata Feeds',
  cnNos: ['CN-26-104790'],
  product: {
    name: 'Toxin binder',
    variantName: '25 kg',
    brandName: 'Sri Venkata Feeds',
    packLabel: '25 KG',
    imageUrl: null,
    coldChain: null,
  },
  status: 'PASS',
  statusText: 'Both certificates passed',
  releasedOn: 'INDEPENDENT_COA',
  quarantine: null,
  certificates: [
    {
      source: 'MANUFACTURER',
      label: 'Manufacturer COA',
      issuer: 'Sri Venkata Feeds QC',
      selfDeclared: true,
      accreditation: null,
      analystName: 'R. Kumari',
      signatoryName: 'QC Head',
      signedOn: '2026-09-18',
      labRef: null,
      verdict: 'PASS',
      documentUrl: 'https://media.farmx.in/signed/…',
    },
    {
      source: 'INDEPENDENT',
      label: 'Interferon Labs COA',
      issuer: 'Interferon Labs',
      selfDeclared: false,
      accreditation: 'NABL ISO 17025',
      analystName: 'K. Divya',
      signatoryName: 'Dr. M. Harsha',
      signedOn: '2026-09-26',
      labRef: 'IFN-26-08499',
      verdict: 'PASS',
      documentUrl: 'https://media.farmx.in/signed/…',
    },
  ],
  parameters: [
    {
      code: 'MOISTURE',
      name: 'Moisture',
      unit: '%',
      spec: '≤ 12 %',
      manufacturer: { value: 9.4, verdict: 'CONFORMS' },
      independent: { value: 9.8, verdict: 'CONFORMS' },
      failed: false,
    },
    {
      code: 'LEAD',
      name: 'Lead (Pb)',
      unit: 'ppm',
      spec: '≤ 10 ppm',
      manufacturer: { value: 3.1, verdict: 'CONFORMS' },
      independent: { value: 3.4, verdict: 'CONFORMS' },
      failed: false,
    },
  ],
  whatFailed: [],
  mismatch: null,
  pending: null,
  timeline: [],
  policy:
    'If the independent result fails: the whole consignment is quarantined. You will be told immediately, with return steps. Manufacturer and independent results remain separately labelled.',
};

const UNVERIFIED = {
  message:
    'The scanned code does not belong to any FarmX authenticated consignment or certified manufacturer lot',
  details: { reason: 'UNVERIFIED_CODE', hint: 'Scan the FarmX QR sticker, not the courier label' },
};

export const certificatesDocs = {
  list: {
    tag: CUSTOMER_TAG,
    summary: 'My certificates (search by number)',
    description:
      '"Certificates" screen: the caller\'s received batches with the COA count and status (PASS · LAB_PENDING · FAILED · QUARANTINED). `q` matches a CN number prefix, an order number prefix or a product name.',
    auth: AUTH_CUSTOMER,
    rateLimit: '120 per user per minute',
    success: {
      status: 200,
      description: 'Rows',
      paginated: true,
      example: {
        success: true,
        data: [
          {
            batchId: IDS.batch,
            batchNo: 'TB-0926',
            cnNo: 'CN-26-104790',
            cnNos: ['CN-26-104790'],
            product: CARD.product,
            vendorName: 'Sri Venkata Feeds',
            orderId: IDS.receipt,
            orderNo: 'ORD-26-0091842',
            qty: 4,
            dispatchedAt: '2026-10-02T06:00:00.000Z',
            coaCount: 2,
            status: 'PASS',
            statusText: 'Both certificates passed',
          },
        ],
        meta: { nextCursor: null, limit: 20 },
      },
    },
  },
  unit: {
    tag: CUSTOMER_TAG,
    summary: 'Scan pack QR → scan result & journey',
    description:
      'Genuine FarmX unit: product, batch, unit n of m, mfg / expiry, source CN, both COAs. `order`, the delivery steps of `journey` and `watching` only when the caller received this unit; journey temperatures / PO are Future (null). Unknown code → 404 `UNVERIFIED_CODE` ("Invalid QR Code Scanned").',
    auth: AUTH_CUSTOMER,
    errors: [404, 503],
    errorExamples: { 404: UNVERIFIED },
    success: {
      status: 200,
      description: 'Scan result',
      example: {
        success: true,
        data: {
          qrCode: 'QR-VAC-0048-0007',
          genuine: true,
          badge: 'Genuine FarmX unit',
          yours: true,
          unit: { seq: 7, of: 8 },
          sourceCn: 'CN-26-104882',
          order: { orderId: IDS.receipt, orderNo: 'ORD-26-0091842' },
          journey: [
            {
              key: 'VENDOR',
              title: 'Vendor',
              detail: 'Godavari Biologicals',
              badge: 'QC Approved',
              at: null,
              reading: null,
            },
            {
              key: 'WAREHOUSE',
              title: 'Tanuku C&F Depot',
              detail: 'Received and allocated',
              badge: null,
              at: '2026-09-29T05:00:00.000Z',
              reading: null,
            },
            {
              key: 'VEHICLE',
              title: 'AP 39 TK 4417',
              detail: 'Dispatched',
              badge: null,
              at: '2026-10-01T06:00:00.000Z',
              reading: null,
            },
            {
              key: 'FARM',
              title: 'Your farm',
              detail: 'OTP and photo proof',
              badge: 'Verified',
              at: '2026-10-02T06:13:00.000Z',
              reading: null,
            },
          ],
          watching: false,
          ...CARD,
        },
      },
    },
  },
  consignment: {
    tag: CUSTOMER_TAG,
    summary: 'COA verification of a consignment',
    description:
      'C-24b (both pass), C-25b (failed: quarantine banner, what failed, timeline), Lab pending (step x of 4, expected date) and Certificate Audit Alert (`mismatch`). Only batches of the CN the caller received; else 404.',
    auth: AUTH_CUSTOMER,
    errors: [404],
    success: {
      status: 200,
      description: 'Consignment',
      example: {
        success: true,
        data: {
          cnNo: 'CN-26-104790',
          batches: [{ ...CARD, watching: false }],
          yourOrders: [
            {
              orderId: IDS.receipt,
              orderNo: 'ORD-26-0091842',
              dispatchedAt: '2026-10-02T06:00:00.000Z',
            },
          ],
          privacyNote: PRIVACY,
          verify: { code: 'CN-26-104790', path: '/v1/verify/CN-26-104790', loginRequired: false },
        },
      },
    },
  },
  watch: {
    tag: CUSTOMER_TAG,
    summary: "Notify me when it's published",
    description:
      'Lab pending toggle. The caller is told (in-app / push) when the independent COA of their batches is published.',
    auth: AUTH_CUSTOMER,
    rateLimit: '30 per user per minute',
    errors: [404],
    requestExample: { watch: true },
    success: {
      status: 200,
      description: 'Saved',
      example: { success: true, data: { cnNo: 'CN-26-104761', watching: true, batches: 1 } },
    },
  },
  verify: {
    tag: PUBLIC_TAG,
    summary: 'Verify a unit QR or consignment number',
    description:
      '"Show a buyer or inspector": a unit QR code or a CN number → goods, batch, certificates and verdict. An explicit allow-list: no buyer, farm, order, shipment or delivery fields ever.',
    auth: AUTH_PUBLIC,
    public: true,
    rateLimit: '60 per IP per minute',
    errors: [404, 503],
    errorExamples: { 404: UNVERIFIED },
    success: {
      status: 200,
      description: 'Verified',
      example: {
        success: true,
        data: {
          code: 'CN-26-104790',
          type: 'CONSIGNMENT',
          genuine: true,
          batches: [
            {
              batchNo: CARD.batchNo,
              mfgDate: CARD.mfgDate,
              expiryDate: CARD.expiryDate,
              cnNos: CARD.cnNos,
              product: CARD.product,
              status: CARD.status,
              statusText: CARD.statusText,
              quarantine: null,
              certificates: CARD.certificates,
              parameters: CARD.parameters,
              whatFailed: [],
              mismatch: null,
            },
          ],
          privacyNote: PRIVACY,
        },
      },
    },
  },
} satisfies Record<string, RouteDocs>;
