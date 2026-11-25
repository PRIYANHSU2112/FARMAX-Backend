import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gstinCheckChar } from '../../src/features/invoices/invoices.tax-ids.js';
import {
  app,
  call,
  captured,
  customer,
  data,
  deliver,
  orderRow,
  staff,
  startOrdersApp,
  type OrderView,
} from './orders.harness.js';

/** Shared invoice test setup (D-48 core + D-61 dispatch / credit notes / APIs). */

/** Syntactically valid test GSTINs (checksum computed; not real entities). */
export const gstin = (state: string, pan: string) =>
  `${state}${pan}1Z${gstinCheckChar(`${state}${pan}1Z`)}`;
export const SELLER_GSTIN = gstin('37', 'AABCF1234A');

export const taxed = randomUUID(); // ₹100, 18 %, ambient
export const cold = randomUUID(); // ₹250, 12 %, cold chain (adds freight)
const reviewer = staff('orders.view', 'orders.confirm');

export interface Doc {
  id: string;
  docType: string;
  docNo: string;
  replayed: boolean;
  linesHash?: string;
  voidedDocNo?: string | null;
}

const variantFacts = (
  variantId: string,
  o: { sku: string; gst: string; temp: string; hsn: string },
) => ({
  variantId,
  productId: randomUUID(),
  sku: o.sku,
  barcode: null,
  productName: `IT ${o.sku}`,
  variantName: '1 unit',
  manufacturerName: null,
  packSize: '1',
  packUnit: 'NOS',
  isPrescriptionRequired: false,
  temperatureClass: o.temp,
  shelfLifeMonths: null,
  isActive: true,
  categoryId: randomUUID(),
  categoryPath: [],
  brandId: randomUUID(),
  hsnCode: o.hsn,
  gstRate: o.gst,
  minOrderQty: 1,
  maxOrderQty: 500,
  version: 1,
});

/** Seller configured, private local storage, a per-run series, two priced variants. */
export const startInvoiceApp = async (env: Record<string, string> = {}) => {
  await startOrdersApp({
    SELLER_GSTIN,
    SELLER_LEGAL_NAME: 'FarmX Agritech Private Limited',
    SELLER_ADDRESS: 'Plot 12, APIIC IDA, Nuzvid, Andhra Pradesh 521201',
    INVOICE_STORAGE: 'local',
    INVOICE_LOCAL_DIR: join(tmpdir(), `farmx-it-invoices-${randomUUID()}`),
    // A per-run series keeps these tests' numbers independent of earlier runs.
    INVOICE_SERIES: randomSeries(),
    CREDIT_NOTE_SERIES: randomSeries(),
    ...env,
  });
  await deliver(
    'product.variant_created.v1',
    variantFacts(taxed, { sku: 'IT-INV-18', gst: '18.00', temp: 'AMB', hsn: '30023000' }),
  );
  await deliver(
    'product.variant_created.v1',
    variantFacts(cold, { sku: 'IT-INV-CC', gst: '12.00', temp: 'CC_REF', hsn: '3002' }),
  );
  for (const [variantId, price] of [
    [taxed, '100.00'],
    [cold, '250.00'],
  ] as const)
    await deliver('pricing.price_changed.v1', {
      variantId,
      sellingPrice: price,
      currency: 'INR',
      effectiveFrom: new Date().toISOString(),
      sequence: 1,
    });
};

const randomSeries = () =>
  String.fromCharCode(
    65 + Math.floor(Math.random() * 26),
    65 + Math.floor(Math.random() * 26),
    65 + Math.floor(Math.random() * 26),
  );

/** A CONFIRMED order (paid exactly, stock committed, admin-confirmed) with these items. */
export const confirmedOrder = async (
  items: { variantId: string; qty: number }[],
  stateCode = '37',
) => {
  const user = customer();
  const farmId = randomUUID();
  await deliver('farm.facts_changed.v1', {
    farmId,
    farmCode: `FX-IT-${randomUUID().slice(0, 6)}`,
    ownerUserId: user,
    name: 'Sri Lakshmi Poultry',
    category: 'POULTRY_FARM',
    productionTypes: ['LAYER'],
    gstin: null,
    stateCode,
    territoryCode: 'WG',
    pinCode: '534211',
    status: 'ACTIVE',
    version: 1,
  });
  for (const item of items) {
    const res = await call('POST', '/cart/items', { user, payload: item });
    if (res.statusCode >= 300) throw new Error(res.body);
  }
  const cart = data<{ cartVersion: number }>(await call('GET', `/cart?farmId=${farmId}`, { user }));
  const res = await call('POST', '/orders/checkout', {
    user,
    idem: `chk-${randomUUID()}`,
    payload: { farmId, addressId: randomUUID(), cartVersion: cart.cartVersion, billToGst: false },
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  const placed = data<{ order: OrderView; payment: { paymentId: string } }>(res);
  const totalPaise = Math.round(Number(placed.order.grandTotal) * 100);
  await captured(placed, totalPaise);
  await deliver('inventory.reservation_committed.v1', {
    reservationId: randomUUID(),
    orderRef: placed.order.id,
    recovered: false,
  });
  const ok = await call('POST', `/admin/orders/${placed.order.id}/confirm`, {
    user: reviewer,
    payload: { expectedVersion: (await orderRow(placed.order.id)).version },
  });
  if (ok.statusCode !== 200) throw new Error(ok.body);
  return { ...placed.order, totalPaise, user };
};

/** The F1 hook directly (inside a transaction), as the internal route runs it. */
export const issue = (
  orderId: string,
  lines: { lineNo: number; qty: number }[],
  shipmentId = randomUUID(),
) =>
  app.diContainer.resolve('runInTransaction')((tx) =>
    app.diContainer
      .resolve('ordersService')
      .issueShipmentInvoiceInTx(tx, orderId, { shipmentId, lines }, null),
  ) as Promise<Doc>;

export async function docsOf(orderId: string) {
  return await app.diContainer.resolve('db').taxDocument.findMany({
    where: { orderId },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
    orderBy: { docNo: 'asc' },
  });
}

export const seqOf = (docNo: string) => Number(docNo.split('/')[2]);
