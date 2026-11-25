import { NotFoundError, ServiceUnavailableError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type {
  QualityVariantFactsV1,
  VariantFactsV1,
  WarehouseReceiptCreatedV1,
  WarehouseShipmentBatchesV1,
} from '@farmx/infra/events';

import type { ProductClient } from '../../adapters/product-client.js';
import type { ProjectionsRepository } from './projections.repository.js';

/** "50" + "KG" → "50 KG". */
const packLabel = (size: string, unit: string): string =>
  `${size.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')} ${unit}`.trim().slice(0, 60);

/** Variant facts carried on a warehouse event → projection row. */
export const variantRow = (v: QualityVariantFactsV1) => ({
  variantId: v.variantId,
  productId: v.productId,
  sku: v.sku.slice(0, 40),
  name: v.productName.slice(0, 250),
  variantName: v.variantName.slice(0, 250),
  brandName: v.brandName,
  packLabel: v.packLabel.slice(0, 60),
  imageUrl: v.imageUrl,
  temperatureClass: v.temperatureClass,
});

const fromProduct = (v: VariantFactsV1) => ({
  variantId: v.variantId,
  productId: v.productId,
  sku: v.sku.slice(0, 40),
  name: v.productName.slice(0, 250),
  variantName: v.variantName.slice(0, 250),
  brandName: v.brandName ?? null,
  packLabel: packLabel(v.packSize, v.packUnit),
  imageUrl: v.primaryImageUrl ?? null,
  temperatureClass: v.temperatureClass,
});

const dateOf = (v: string | null): Date | null =>
  v === null ? null : new Date(`${v.slice(0, 10)}T00:00:00.000Z`);

/**
 * Facts owned by warehouse-service (batches, CN lines, buyers) and product-service (variant
 * names), kept as read-only projections. Other features read them only through this service.
 */
export class ProjectionsService {
  constructor(
    private readonly deps: {
      projectionsRepository: ProjectionsRepository;
      productClient: ProductClient;
    },
  ) {}

  private get repo() {
    return this.deps.projectionsRepository;
  }

  /** Variant facts for a spec of a SKU that was never received yet (fetched once). */
  async ensureVariant(variantId: string) {
    const row = await this.repo.variant(variantId);
    if (row !== null) return row;
    const facts = await this.deps.productClient.variantFacts([variantId]);
    if (facts === null)
      throw new ServiceUnavailableError('Product details are unavailable, try again shortly');
    const f = facts.find((v) => v.variantId === variantId);
    if (f === undefined) throw new NotFoundError('Product variant');
    return this.repo.insertVariantIfMissing(fromProduct(f));
  }

  async variants(ids: readonly string[]) {
    return new Map((await this.repo.variants([...new Set(ids)])).map((v) => [v.variantId, v]));
  }
  variantIdsMatching(term: string, take = 500) {
    return this.repo.variantIdsMatching(term, take);
  }

  /** One batch; pass `tx` to read inside a transaction. */
  async batch(batchId: string, tx?: Tx) {
    return this.repo.batch(batchId, tx);
  }
  async batches(ids: readonly string[]) {
    return new Map((await this.repo.batches([...new Set(ids)])).map((b) => [b.batchId, b]));
  }
  /** COA auto-link candidates: same batch number, narrowed by variant and / or CN. */
  async findBatches(batchNo: string, variantId?: string, cnNo?: string) {
    const byCn = cnNo === undefined ? undefined : await this.repo.batchIdsOfCn(cnNo);
    return this.repo.batchesByNo(batchNo, {
      ...(variantId === undefined ? {} : { variantId }),
      ...(byCn === undefined ? {} : { batchIds: byCn }),
    });
  }
  batchIdsByNoContaining(term: string) {
    return this.repo.batchIdsByNoContaining(term);
  }
  batchIdsOfVariants(variantIds: readonly string[]) {
    return this.repo.batchIdsOfVariants(variantIds);
  }

  async latestReceiptLine(batchId: string, warehouseId: string, cnNo?: string) {
    return this.repo.latestLine(batchId, warehouseId, cnNo);
  }
  async receiptLines(batchIds: readonly string[], tx?: Tx) {
    return this.repo.linesOfBatches(batchIds, tx);
  }
  batchIdsOfCn(cnNo: string) {
    return this.repo.batchIdsOfCn(cnNo);
  }
  batchIdsOfCnPrefix(prefix: string) {
    return this.repo.batchIdsOfCnPrefix(prefix);
  }
  batchIdsInWarehouses(warehouseIds: readonly string[]) {
    return this.repo.batchIdsInWarehouses(warehouseIds);
  }
  receivingWarehouses(batchId: string) {
    return this.repo.receivingWarehouses(batchId);
  }
  unitsReceived(batchId: string) {
    return this.repo.unitsReceived(batchId);
  }
  cnNosOf(batchId: string, tx?: Tx) {
    return this.repo.cnNosOf(batchId, tx);
  }

  async buyersOf(tx: Tx, batchId: string) {
    return this.repo.buyersOf(tx, batchId);
  }
  async customerRows(
    customerUserId: string,
    f: { batchIds?: string[]; orderPrefix?: string },
    skip: number,
    take: number,
  ) {
    return this.repo.customerRows(customerUserId, f, skip, take);
  }
  async customerRowsIn(customerUserId: string, batchIds: readonly string[]) {
    return this.repo.customerRowsIn(customerUserId, batchIds);
  }

  /** `warehouse.receipt_created.v1`: variants, batches and CN lines. */
  async applyReceipt(tx: Tx, d: WarehouseReceiptCreatedV1): Promise<void> {
    for (const line of d.lines) {
      await this.repo.upsertVariant(tx, variantRow(line.variant));
      await this.repo.upsertBatch(
        tx,
        {
          batchId: line.batchId,
          variantId: line.variant.variantId,
          batchNo: line.batchNo,
          mfgDate: dateOf(line.mfgDate),
          expiryDate: dateOf(line.expiryDate),
          vendorId: d.vendorId,
          vendorName: d.vendorName,
          serialized: line.serialized,
        },
        {
          mfgDate: dateOf(line.mfgDate),
          expiryDate: dateOf(line.expiryDate),
          serialized: line.serialized,
          ...(d.vendorId === null ? {} : { vendorId: d.vendorId, vendorName: d.vendorName }),
        },
      );
    }
    await this.repo.insertLines(
      tx,
      d.lines.map((l) => ({
        receiptId: d.receiptId,
        lineNo: l.lineNo,
        cnNo: d.cnNo,
        warehouseId: d.warehouseId,
        warehouseName: d.warehouseName.slice(0, 120),
        batchId: l.batchId,
        variantId: l.variant.variantId,
        qty: l.qty,
        initialStatus: l.initialStatus,
        receivedAt: new Date(d.receivedAt),
      })),
    );
  }

  /** `warehouse.shipment_batches.v1`: who received which batch. Returns the batch ids. */
  async applyShipment(tx: Tx, d: WarehouseShipmentBatchesV1): Promise<string[]> {
    const byBatch = new Map<string, { variantId: string; qty: number }>();
    for (const l of d.lines) {
      const cur = byBatch.get(l.batchId);
      byBatch.set(l.batchId, { variantId: l.variantId, qty: (cur?.qty ?? 0) + l.qty });
    }
    await this.repo.insertBuyers(
      tx,
      [...byBatch].map(([batchId, l]) => ({
        shipmentId: d.shipmentId,
        batchId,
        customerUserId: d.customerUserId,
        orderId: d.orderId,
        orderNo: d.orderNo,
        variantId: l.variantId,
        warehouseId: d.warehouseId,
        qty: l.qty,
        dispatchedAt: new Date(d.dispatchedAt),
      })),
    );
    return [...byBatch.keys()];
  }
}
