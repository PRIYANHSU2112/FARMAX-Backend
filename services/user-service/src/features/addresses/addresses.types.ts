export const ADDRESS_TYPES = ['HOME', 'FARM', 'WAREHOUSE', 'OFFICE', 'OTHER'] as const;
export type AddressType = (typeof ADDRESS_TYPES)[number];

/** Fields the customer edits. */
export interface AddressFields {
  type: AddressType;
  label: string | null;
  contactName: string;
  contactPhone: string;
  line1: string;
  line2: string | null;
  landmark: string | null;
  village: string | null;
  mandal: string | null;
  district: string;
  stateCode: string;
  pinCode: string;
  latitude: number | null;
  longitude: number | null;
}

/** Customer view (`/me/addresses`). */
export interface AddressView extends AddressFields {
  id: string;
  isDefault: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Support view (admin): owner + soft-delete marker. */
export interface AdminAddressView extends AddressView {
  userId: string;
  deletedAt: Date | null;
}

type Required = 'contactName' | 'contactPhone' | 'line1' | 'district' | 'stateCode' | 'pinCode';

export type CreateAddressInput = Pick<AddressFields, Required> &
  Partial<Omit<AddressFields, Required>> & { isDefault?: boolean };

/** `isDefault` is not editable here: use `POST /{id}/default` (keeps exactly one default). */
export type UpdateAddressInput = Partial<AddressFields>;

/**
 * Frozen copy order-service stores in the order at checkout (v1 contract). Later edits bump
 * `version` and never change a stored snapshot.
 */
export interface AddressSnapshotV1 extends AddressFields {
  addressId: string;
  userId: string;
  version: number;
  deleted: boolean;
  /** One-line postal form for invoices and labels. */
  formatted: string;
}

export interface AdminAddressQuery {
  includeDeleted?: boolean;
}
