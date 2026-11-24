import type { OwnerType, StockStatus } from './stock.rules.js';

export interface ReceiptLineInput {
  variantId: string;
  batchNo: string;
  mfgDate?: string | null;
  expiryDate?: string | null;
  qty: number;
  binId?: string | null;
  ownerType?: OwnerType;
  vendorId?: string | null;
}

export interface ReceiptInput {
  warehouseId: string;
  /** VENDOR (default, CN-…) or RETURN (customer return, RT-…, lands in RETURNED). */
  sourceType?: 'VENDOR' | 'RETURN';
  vendorId?: string | null;
  restockRequestId?: string | null;
  notes?: string | null;
  lines: ReceiptLineInput[];
}

export interface QualityInput {
  warehouseId: string;
  batchId: string;
  binId?: string | null;
  /** Default: everything in the source status. */
  qty?: number;
  from?: 'QC_HOLD' | 'QUARANTINED' | 'RETURNED';
  to?: 'QC_HOLD' | 'QUARANTINED';
  reason?: string;
}

export interface StatusChangeInput {
  positionId: string;
  from: StockStatus;
  to: StockStatus;
  qty: number;
  reason: string;
}

export interface MoveInput {
  positionId: string;
  toBinId: string;
  qty: number;
  status?: StockStatus;
  reason?: string;
}

export interface AdjustmentInput {
  warehouseId: string;
  reasonCode: string;
  note?: string | null;
  lines: { positionId: string; status: StockStatus; delta: number }[];
}

export interface OwnerFixInput {
  ownerType: OwnerType;
  vendorId?: string | null;
  reason: string;
}

export interface RelabelInput {
  reason: string;
  splits: {
    batchNo: string;
    mfgDate?: string | null;
    expiryDate?: string | null;
    binId?: string | null;
    qty: number;
  }[];
}

export interface CoaInput {
  warehouseId: string;
  coaRef?: string | null;
  /** media-service upload receipt (purpose wms_document). */
  receipt?: string | null;
  certificateStatus?: 'NONE' | 'SAMPLE_REFERENCE' | 'VALID' | 'EXPIRED' | 'REJECTED';
  qualityNote?: string | null;
}

export interface ThresholdInput {
  safetyStock: number;
  reorderLevel: number;
  targetStock: number;
}

export interface ProposalInput {
  from: StockStatus;
  to: StockStatus;
  action?: 'ADD' | 'REMOVE';
  reasonEvent: string;
  roleLabel?: string | null;
}

export interface ProposalDecision {
  note?: string | null;
  /** On approval of an ADD: who may do it (permission key) and the label shown. */
  permissionKey?: string | null;
  roleLabel?: string | null;
}

export interface VendorInput {
  code: string;
  name: string;
  gstin?: string | null;
  phone?: string | null;
  email?: string | null;
  defaultOwnership?: OwnerType;
  status?: 'ACTIVE' | 'INACTIVE';
}

export interface VendorVariantInput {
  variantId: string;
  ownershipModel: OwnerType;
  leadTimeDays?: number;
  moq?: number;
  isPreferred?: boolean;
  requiresUnitQr?: boolean;
}
