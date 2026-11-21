export type WalletJournalKind =
  | 'TOPUP'
  | 'ORDER_DEBIT'
  | 'REFUND_CREDIT'
  | 'POINTS_CONVERSION'
  | 'ADJUSTMENT_CREDIT'
  | 'ADJUSTMENT_DEBIT'
  | 'REVERSAL';

export type WalletCategory = 'TOPUPS' | 'PURCHASES' | 'REFUNDS' | 'REWARDS' | 'ADJUSTMENTS';

/** The counterparty of every user posting (seeded by the migration). */
export type SystemAccountCode =
  'GATEWAY_CLEARING' | 'ORDER_SETTLEMENT' | 'REWARDS_EXPENSE' | 'ADJUSTMENT';

export type Direction = 'CREDIT' | 'DEBIT';

export type AccountStatus = 'ACTIVE' | 'FROZEN';

/** One money movement of one customer's wallet (one journal, two postings). */
export interface PostInput {
  /** Unique business key: a repeat with the same key returns the first result (no new money). */
  idempotencyKey: string;
  userId: string;
  kind: WalletJournalKind;
  category: WalletCategory;
  /** CREDIT raises the customer's balance, DEBIT lowers it (refused when short or frozen). */
  direction: Direction;
  /** > 0, integer paise. */
  amountPaise: bigint;
  counterparty: SystemAccountCode;
  title: string;
  subtitle?: string | null;
  refType?: string | null;
  refId?: string | null;
  metadata?: Record<string, unknown> | null;
  reversalOf?: string | null;
  createdBy?: string | null;
  /** Event correlation (request id / causing event); defaults to the journal id. */
  correlationId?: string;
}

export interface JournalRow {
  id: string;
  journalNo: string;
  kind: WalletJournalKind;
  category: WalletCategory;
  idempotencyKey: string;
  userId: string;
  amountPaise: bigint;
  refType: string | null;
  refId: string | null;
  title: string;
  subtitle: string | null;
  metadata: unknown;
  reversalOf: string | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface AccountRow {
  id: string;
  userId: string | null;
  balancePaise: bigint;
  status: AccountStatus;
  frozenReason: string | null;
  frozenAt: Date | null;
  currency: string;
}

export interface PostResult {
  journal: JournalRow;
  direction: Direction;
  balanceAfterPaise: bigint;
  /** true = the idempotency key was already used; nothing moved this time. */
  replayed: boolean;
}

/** "1234.50" from 123450n (wallet balances are never negative). */
export const rupees = (paise: bigint): string => {
  const sign = paise < 0n ? '-' : '';
  const abs = paise < 0n ? -paise : paise;
  return `${sign}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
};

/** Last 7 days ("+₹9,684.20 … this week", "+8.42%"). */
export interface WeekView {
  /** Money that came IN during the last 7 days (top-ups, refunds, rewards, credits). */
  creditsPaise: number;
  credits: string;
  /** Balance change vs. 7 days ago, 2 decimals ("8.42", "-3.10"); null when it was ₹0. */
  changePercent: string | null;
}

export interface BalanceView {
  balancePaise: number;
  balance: string;
  currency: string;
  status: AccountStatus;
  frozenReason: string | null;
  week: WeekView;
}

/** (now − before) / before × 100, exact to 2 decimals (truncated), from integer paise. */
export const changePercent = (now: bigint, before: bigint): string | null => {
  if (before <= 0n) return null;
  const hundredths = ((now - before) * 10_000n) / before;
  const sign = hundredths < 0n ? '-' : '';
  const abs = hundredths < 0n ? -hundredths : hundredths;
  return `${sign}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
};

/** A customer without an account yet simply has ₹0 (accounts are created on the first credit). */
export const toBalanceView = (
  account: AccountRow | null,
  week: { creditsPaise: bigint; balanceBeforePaise: bigint } = {
    creditsPaise: 0n,
    balanceBeforePaise: 0n,
  },
): BalanceView => {
  const balance = account?.balancePaise ?? 0n;
  return {
    balancePaise: Number(balance),
    balance: rupees(balance),
    currency: account?.currency ?? 'INR',
    status: account?.status ?? 'ACTIVE',
    frozenReason: account?.frozenReason ?? null,
    week: {
      creditsPaise: Number(week.creditsPaise),
      credits: rupees(week.creditsPaise),
      changePercent: changePercent(balance, week.balanceBeforePaise),
    },
  };
};

export interface JournalFilter {
  userId?: string;
  category?: WalletCategory;
  kind?: WalletJournalKind;
  /** Inclusive start / exclusive end. */
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

/** A reconciliation finding (persisted by the checks feature). */
export interface Mismatch {
  checkType: string;
  refId: string;
  userId: string | null;
  expected: string;
  actual: string;
}

/** The status word under the amount in the statement ("Approved", "Completed", …). */
export const STATUS_LABEL: Record<WalletJournalKind, string> = {
  TOPUP: 'Wallet Added',
  ORDER_DEBIT: 'Completed',
  REFUND_CREDIT: 'Refunded',
  POINTS_CONVERSION: 'Wallet Added',
  ADJUSTMENT_CREDIT: 'Direct Credit',
  ADJUSTMENT_DEBIT: 'Debited',
  REVERSAL: 'Reversed',
};

export interface TransactionView {
  id: string;
  journalNo: string;
  kind: WalletJournalKind;
  category: WalletCategory;
  direction: Direction;
  /** Signed: + money in, − money out. */
  amountPaise: number;
  amount: string;
  title: string;
  subtitle: string | null;
  statusLabel: string;
  balanceAfterPaise: number | null;
  refType: string | null;
  refId: string | null;
  createdAt: Date;
}

export const toTransactionView = (
  j: JournalRow,
  posting: { amountPaise: bigint; balanceAfterPaise: bigint | null } | undefined,
): TransactionView => {
  const signed = posting?.amountPaise ?? j.amountPaise;
  return {
    id: j.id,
    journalNo: j.journalNo,
    kind: j.kind,
    category: j.category,
    direction: signed < 0n ? 'DEBIT' : 'CREDIT',
    amountPaise: Number(signed),
    amount: rupees(signed),
    title: j.title,
    subtitle: j.subtitle,
    statusLabel: STATUS_LABEL[j.kind],
    balanceAfterPaise:
      posting?.balanceAfterPaise === undefined || posting.balanceAfterPaise === null
        ? null
        : Number(posting.balanceAfterPaise),
    refType: j.refType,
    refId: j.refId,
    createdAt: j.createdAt,
  };
};
