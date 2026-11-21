/** payment-service: pay a whole order from the wallet (one debit per payment). */
export interface DebitInput {
  paymentId: string;
  userId: string;
  orderId: string;
  orderNo: string;
  amountPaise: number;
}

/** payment-service refund executor: give (part of) a wallet-paid payment back to the wallet. */
export interface CreditInput {
  refundId: string;
  paymentId: string;
  userId: string;
  amountPaise: number;
  reason: string;
}

export interface DebitView {
  status: 'DEBITED' | 'NONE';
  paymentId: string;
  journalId: string | null;
  journalNo: string | null;
  amountPaise: number;
  /** Refunded back to the wallet so far. */
  refundedPaise: number;
  balanceAfterPaise: number | null;
  /** true = this payment was already debited (a retry); nothing moved now. */
  replayed: boolean;
}

export interface CreditView {
  refundId: string;
  journalId: string;
  journalNo: string;
  amountPaise: number;
  balanceAfterPaise: number;
  replayed: boolean;
}
