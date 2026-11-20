export type TransactionKind = 'CAPTURE' | 'REFUND';

/** One ledger row as APIs show it (paise + rupee string; never instrument data). */
export interface LedgerEntryView {
  id: string;
  kind: TransactionKind;
  amountPaise: number;
  /** Rupees with paise, e.g. "27821.00". */
  amount: string;
  currency: string;
  method: string | null;
  paymentId: string;
  refundId: string | null;
  providerRef: string | null;
  sourceRef: string | null;
  occurredAt: Date;
  recordedAt: Date;
}

export interface LedgerSummary {
  capturedPaise: number;
  refundedPaise: number;
  /** captured − refunded. */
  netPaise: number;
  captured: string;
  refunded: string;
  net: string;
}

export interface OrderLedgerView {
  orderId: string;
  summary: LedgerSummary;
  transactions: LedgerEntryView[];
}

export interface NewLedgerEntry {
  orderId: string;
  kind: TransactionKind;
  amountPaise: number;
  currency: string;
  method: string | null;
  paymentId: string;
  refundId: string | null;
  providerRef: string | null;
  sourceRef: string | null;
  idempotencyKey: string;
  sourceEventId: string | null;
  occurredAt: Date;
}

export interface LedgerCheckView {
  paymentId: string;
  orderId: string;
  status: 'OK' | 'MISMATCH';
  ledgerCapturedPaise: number;
  ledgerRefundedPaise: number;
  paymentCapturedPaise: number;
  paymentRefundedPaise: number;
  checkedAt: Date;
}

export interface PaymentTotals {
  capturedPaise: number;
  refundedPaise: number;
}
