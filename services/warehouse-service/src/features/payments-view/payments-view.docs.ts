import Joi from 'joi';

import { wmsDoc } from '../../docs/shared.js';
import { PAGE_META } from '../../middleware/paging.js';

export const PAYMENTS_AREA = 'Payments (prepaid)';

const any = Joi.object().unknown(true);

export const paymentsViewDocs = (aud: 'panel' | 'admin') => {
  const d = (s: string, o: Parameters<typeof wmsDoc>[4] = {}) =>
    wmsDoc(aud, PAYMENTS_AREA, s, 'fulfilment.view', o);
  return {
    kpis: d('KPI cards', {
      data: any,
      description:
        'For a month (IST): prepaid cleared (orders, value), pending payment, failed / expired, refund claims (total, open, refunded value), on hold, customers, clearance rate. Credit cards: `credit: null`, `modules.credit: false` (prepaid only).',
    }),
    orders: d('Payment ledger', {
      paginated: true,
      data: Joi.array().items(any),
      meta: PAGE_META,
      description:
        'Tabs: all, paid, pending, refunds ("Refund Claims"), failed, held (+ `tabs` counts). Row: order no, customer + code, PO ref, amount, status, valuation ("UPI • Paid in advance"), masked reference, refund status / amount, hold, terms PREPAID. Search, instrument filter, cursor or page.',
    }),
    csv: d('Export ledger (CSV)', { description: 'Streamed; CSV-injection safe. 5 per minute.' }),
    customer: d('Customer panel', {
      data: any,
      errors: [404],
      description:
        'Orders, paid value, refunds, first / last order, customer code, terms PREPAID, 5 recent orders. Credit limit / utilisation: `modules.credit: false`.',
    }),
    sla: d('Reconciliation SLA (payment clearance)', {
      data: any,
      description:
        'From payment-service: payments created, captured, failed, expired, pending, captured value, average / p95 seconds to capture, % captured within 5 minutes. `modules.paymentStats: false` when payment-service is unreachable.',
    }),
  };
};
