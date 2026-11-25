export type ReservationStatus =
  'ACTIVE' | 'COMMITTED' | 'ISSUED' | 'RELEASED' | 'EXPIRED' | 'REJECTED';

export interface ReservationLineView {
  warehouseId: string;
  variantId: string;
  qty: number;
  releasedQty: number;
  issuedQty: number;
  /** Units held now: qty − releasedQty − issuedQty while ACTIVE / COMMITTED, else 0. */
  heldQty: number;
}

export interface ReservationView {
  id: string;
  orderRef: string;
  status: ReservationStatus;
  pinCode: string;
  expiresAt: Date;
  paymentRef: string | null;
  committedAt: Date | null;
  recoveredFromExpiry: boolean;
  expiredAt: Date | null;
  rejectedAt: Date | null;
  issuedAt: Date | null;
  releasedAt: Date | null;
  releaseReason: string | null;
  releasedByUserId: string | null;
  version: number;
  createdAt: Date;
  lines: ReservationLineView[];
}

export interface ReserveLineInput {
  variantId: string;
  qty: number;
}

export interface ReserveInput {
  /** The caller's order id. */
  orderRef: string;
  pinCode: string;
  lines: ReserveLineInput[];
  /** Hold time while unpaid (order `paymentWindowMinutes`); default = setting. */
  ttlSeconds?: number;
  /** D-57b routing facts (rules on value, district, distance). */
  routing?: {
    orderValue?: number | null;
    district?: string | null;
    stateCode?: string | null;
    lat?: number | null;
    lng?: number | null;
  };
}

export interface AvailabilityCheckInput {
  pinCode: string;
  routing?: ReserveInput['routing'];
  lines: ReserveLineInput[];
}

export interface ReservationListQuery {
  cursor?: string;
  limit: number;
  status?: ReservationStatus;
  orderRef?: string;
}

export interface ReleaseInput {
  reason: string;
}
