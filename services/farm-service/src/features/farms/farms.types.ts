import type { CursorQuery } from '@farmx/common/types';

export type FarmCategory = 'POULTRY_FARM' | 'HATCHERY' | 'FEED_MILL' | 'BACKYARD';
export type ProductionType =
  'LAYER' | 'BROILER' | 'BROILER_BREEDER' | 'LAYER_BREEDER' | 'HATCHERY' | 'FEED_MILL' | 'BACKYARD';
export type FarmStatus =
  | 'DRAFT'
  | 'UNDER_REVIEW'
  | 'NEEDS_ATTENTION'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'REJECTED'
  | 'MERGED'
  | 'CLOSED';
export type KycStatus = 'NOT_STARTED' | 'PENDING' | 'VERIFIED' | 'REJECTED';
export type CapacityMetric = 'BIRDS' | 'EGGS' | 'FEED_TONNES';
export type CapacityPeriod =
  'STANDING' | 'PER_CYCLE' | 'PER_SETTING' | 'PER_WEEK' | 'PER_HOUR' | 'PER_DAY' | 'PER_MONTH';
export type AgeBand = 'AGE_18_30' | 'AGE_31_45' | 'AGE_46_60' | 'AGE_60_PLUS';
export type InvoiceNameSource = 'FARM_NAME' | 'GST_TRADE_NAME';
export type ActorType = 'OWNER' | 'ADMIN' | 'SYSTEM';

export interface CapacityInput {
  productionType: ProductionType;
  metric: CapacityMetric;
  value: number;
  period: CapacityPeriod;
}

export interface CapacityView extends CapacityInput {
  rank: number;
}

export interface OwnerView {
  id: string;
  userId: string;
  fullName: string;
  phone: string | null;
  ageBand: AgeBand | null;
  panMasked: string | null;
  aadhaarLast4: string | null;
  kycStatus: KycStatus;
  personalizedOffers: boolean;
}

export interface LocationView {
  latitude: number | null;
  longitude: number | null;
  gpsAccuracyM: number | null;
  capturedAt: string | null;
  addressLine: string | null;
  village: string | null;
  pinCode: string | null;
  territoryCode: string | null;
  districtName: string | null;
  mandalName: string | null;
  primaryNodeId: string | null;
  backupNodeId: string | null;
}

/** Full farm view (customer detail, admin detail, internal reads). PII masked. */
export interface FarmView {
  id: string;
  farmCode: string | null;
  farmCodePreview: string | null;
  category: FarmCategory;
  productionTypes: ProductionType[];
  name: string;
  status: FarmStatus;
  statusReason: string | null;
  registrationStep: number;
  owner: OwnerView;
  capacities: CapacityView[];
  totalBirdCapacity: number | null;
  location: LocationView | null;
  billing: {
    gstin: string | null;
    invoiceNameSource: InvoiceNameSource;
    invoiceName: string | null;
    /** gstin is set only from an ACTIVE portal verification, so present = verified. */
    gstVerified: boolean;
    /** GST portal "Legal Name of Business". */
    businessName: string | null;
    tradeName: string | null;
    gstVerifiedAt: string | null;
  };
  kycDeferred: boolean;
  channel: string;
  createdByUserId: string;
  mergedIntoFarmId: string | null;
  submittedAt: string | null;
  activatedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface FarmSummary {
  id: string;
  farmCode: string | null;
  name: string;
  category: FarmCategory;
  productionTypes: ProductionType[];
  status: FarmStatus;
  registrationStep: number;
  village: string | null;
  pinCode: string | null;
  totalBirdCapacity: number | null;
  createdAt: string;
}

export interface AdminFarmListItem extends FarmSummary {
  ownerId: string;
  ownerName: string;
  ownerPhone: string | null;
  territoryCode: string | null;
  kycStatus: KycStatus;
  submittedAt: string | null;
}

export interface FarmPassView {
  farmCode: string;
  name: string;
  ownerName: string;
  locationLabel: string;
  productionSummary: string;
  totalBirdCapacity: number | null;
  memberSince: string;
  qr: { payload: string; signature: string };
  shareText: string;
}

/** Candidate found by the dedupe query (one per matching farm). */
export interface DuplicateCandidate {
  farmId: string;
  ownerId: string;
  farmCode: string | null;
  name: string;
  sameOwner: boolean;
  distanceM: number | null;
  nameSimilarity: number;
  panMatch: boolean;
  gstinMatch: boolean;
}

// ── Inputs ──

export interface DetailsInput {
  name: string;
  ownerName: string;
  productionTypes?: ProductionType[];
  capacities: CapacityInput[];
}

export interface LocationInput {
  latitude: number;
  longitude: number;
  accuracyM: number;
  capturedAt: string;
  village: string;
  pinCode: string;
  addressLine?: string;
}

export interface QuickSignupInput {
  ownerName: string;
  addressLine: string;
  village: string;
  pinCode: string;
  latitude?: number;
  longitude?: number;
  accuracyM?: number;
  birds?: number;
  personalizedOffers?: boolean;
}

export interface OwnerPrefsInput {
  ageBand?: AgeBand | null;
  personalizedOffers?: boolean;
}

export interface UpdateActiveFarmInput {
  addressLine?: string;
  capacities?: CapacityInput[];
}

export interface AdminUpdateInput {
  name?: string;
  ownerName?: string;
  addressLine?: string;
  capacities?: CapacityInput[];
  reason: string;
}

export interface FarmListQuery extends CursorQuery {
  status?: FarmStatus;
}

export interface AdminFarmListQuery extends CursorQuery {
  q?: string;
  status?: FarmStatus;
  category?: FarmCategory;
  productionType?: ProductionType;
  territoryCode?: string;
  pinCode?: string;
  kycStatus?: KycStatus;
  channel?: string;
  createdFrom?: string;
  createdTo?: string;
}

export type AdminAction = 'suspend' | 'reactivate' | 'close' | 'reject' | 'request-changes';

/** Owner + farm context handed to the kyc and review features. */
export interface FarmContext {
  farm: FarmView;
  ownerId: string;
  ownerUserId: string;
}
