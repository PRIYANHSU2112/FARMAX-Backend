import { ServiceUnavailableError } from '@farmx/common/errors';
import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';

import type { QualityConfig } from '../config/index.js';

/** warehouse-service `GET /internal/wms/units/:qrCode/trace` (one unit QR → batch, shipment). */
export interface UnitTrace {
  qrCode: string;
  batchId: string;
  variantId: string;
  seq: number;
  /** Units generated for the batch (the "of N" in "unit 7 of 8"). */
  unitCount: number;
  status: string;
  receipt: {
    cnNo: string;
    warehouseId: string;
    warehouseName: string;
    receivedAt: string;
  } | null;
  shipment: {
    shipmentId: string;
    shipmentNo: string;
    orderId: string;
    orderNo: string;
    customerUserId: string;
    warehouseId: string;
    warehouseName: string;
    dispatchedAt: string | null;
    vehicleNo: string | null;
    deliveredAt: string | null;
    otpVerified: boolean;
    hasPhotoProof: boolean;
  } | null;
}

/** Unit trace for the customer QR scan. `null` = unknown code (not a FarmX unit). */
export class WarehouseClient {
  constructor(private readonly deps: { config: QualityConfig; logger: Logger }) {}

  async unitTrace(qrCode: string): Promise<UnitTrace | null> {
    const { config, logger } = this.deps;
    if (config.INTERNAL_SERVICE_TOKEN === undefined)
      throw new ServiceUnavailableError('Unit lookup is not configured');
    let res: Response;
    try {
      res = await fetch(
        `${config.WAREHOUSE_SERVICE_URL}/internal/wms/units/${encodeURIComponent(qrCode)}/trace`,
        {
          headers: { [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN },
          signal: AbortSignal.timeout(3_000),
        },
      );
    } catch (err) {
      logger.warn({ err }, 'warehouse-service unit trace unavailable');
      throw new ServiceUnavailableError('Unit lookup is unavailable, try again shortly', {
        cause: err,
      });
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      logger.warn({ status: res.status }, 'warehouse-service unit trace failed');
      throw new ServiceUnavailableError('Unit lookup is unavailable, try again shortly');
    }
    const body = (await res.json()) as { data?: UnitTrace };
    return body.data ?? null;
  }
}
