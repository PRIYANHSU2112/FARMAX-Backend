export type StockOperationType = 'RECEIPT' | 'DAMAGE' | 'WRITE_OFF' | 'ADJUSTMENT';
export type StockOperationStatus = 'PENDING' | 'APPLIED' | 'REJECTED';
export type StockLedgerType =
  | 'RECEIVE'
  | 'ADJUST_IN'
  | 'ADJUST_OUT'
  | 'DAMAGE'
  | 'WRITE_OFF'
  | 'SALE'
  // D-57a: from warehouse-service movements.
  | 'QUALITY_RELEASE'
  | 'QUALITY_HOLD'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'RETURN';

export interface OperationLine {
  variantId: string;
  /** Positive units (ADJUSTMENT: signed, never 0). */
  qty: number;
}

export interface ReceiptInput {
  warehouseId: string;
  lines: OperationLine[];
  reference?: string;
  reason?: string;
}

export interface DamageInput {
  warehouseId: string;
  lines: OperationLine[];
  reason: string;
}

export type WriteOffInput = DamageInput;
export type AdjustmentInput = DamageInput;

export interface DecisionInput {
  reason: string;
}

export interface ThresholdsInput {
  reorderLevel?: number;
  safetyStock?: number;
  reason: string;
}

export interface OperationView {
  id: string;
  type: StockOperationType;
  status: StockOperationStatus;
  warehouseId: string;
  lines: OperationLine[];
  reference: string | null;
  reason: string | null;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  createdAt: Date;
}

export interface LevelRow {
  id: string;
  warehouseId: string;
  variantId: string;
  onHand: number;
  reserved: number;
  damaged: number;
  safetyStock: number;
  reorderLevel: number;
  lowStockAlerted: boolean;
  version: number;
  updatedAt: Date;
}

export interface LevelView extends LevelRow {
  sku: string | null;
  name: string | null;
  sellable: number;
  lowStock: boolean;
}

export interface LedgerRow {
  id: string;
  warehouseId: string;
  variantId: string;
  type: StockLedgerType;
  onHandDelta: number;
  damagedDelta: number;
  onHandAfter: number;
  damagedAfter: number;
  refType: string;
  refId: string;
  actorUserId: string | null;
  requestId: string | null;
  createdAt: Date;
}

export type NewLedgerRow = Omit<LedgerRow, 'id' | 'createdAt'>;

export interface LevelListQuery {
  cursor?: string;
  limit: number;
  warehouseId?: string;
  variantId?: string;
  lowStock?: boolean;
}

export interface OperationListQuery {
  cursor?: string;
  limit: number;
  warehouseId?: string;
  type?: StockOperationType;
  status?: StockOperationStatus;
}

export interface LedgerListQuery {
  cursor?: string;
  limit: number;
  warehouseId?: string;
  variantId?: string;
  type?: StockLedgerType;
  from?: Date;
  to?: Date;
}

/** One warehouse × variant quantity change (sorted by the caller for lock order). */
export interface StockMove {
  warehouseId: string;
  variantId: string;
  qty: number;
}
