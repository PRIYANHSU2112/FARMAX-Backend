import type { TempClass } from '../warehouses/index.js';

export type ResourceStatus = 'ACTIVE' | 'INACTIVE' | 'MAINTENANCE';

export interface ZoneView {
  id: string;
  code: string;
  name: string;
  temperatureClass: TempClass;
  minTempC: string | null;
  maxTempC: string | null;
  isFoodGrade: boolean;
  productCategoryIds: string[];
  status: ResourceStatus;
  sortOrder: number;
  version: number;
  rackCount: number;
  binCount: number;
}

/** W2.05 racks table: "Available space 7.5 (62%)" = limits not yet given to bins. */
export interface RackView {
  id: string;
  zoneId: string;
  zoneCode: string;
  code: string;
  maxWeightKg: string;
  volumeM3: string;
  binCount: number;
  availableWeightKg: string;
  availableVolumeM3: string;
  availablePct: number;
  status: ResourceStatus;
  version: number;
}

/** W2.05 bins table: available = limit − used (used is 0 until put-away, W8). */
export interface BinView {
  id: string;
  code: string;
  zoneId: string;
  zoneCode: string;
  rackId: string;
  rackCode: string;
  temperatureClass: TempClass;
  maxWeightKg: string;
  volumeM3: string;
  usedWeightKg: string;
  usedVolumeM3: string;
  availableVolumeM3: string;
  availablePct: number;
  status: ResourceStatus;
}

export interface LayoutView {
  warehouseId: string;
  zones: {
    id: string;
    code: string;
    name: string;
    temperatureClass: TempClass;
    isFoodGrade: boolean;
    status: ResourceStatus;
    racks: {
      id: string;
      code: string;
      status: ResourceStatus;
      bins: { id: string; code: string; status: ResourceStatus }[];
    }[];
  }[];
}

export interface ZoneInput {
  code: string;
  name: string;
  temperatureClass: TempClass;
  minTempC?: number | null;
  maxTempC?: number | null;
  isFoodGrade?: boolean;
  productCategoryIds?: string[];
  status?: ResourceStatus;
  sortOrder?: number;
}

export interface ZoneUpdate extends Partial<Omit<ZoneInput, 'code'>> {
  expectedVersion: number;
}

export interface BinLimits {
  maxWeightKg: number;
  volumeM3: number;
}

export interface RackInput extends BinLimits {
  /** Omitted = next free `<zone>-NN`. */
  code?: string;
  status?: ResourceStatus;
  /** Create N bins at once (`<rack>-01` …), each with these limits. */
  generateBins?: { count: number } & BinLimits;
}

export interface RackUpdate extends Partial<BinLimits> {
  expectedVersion: number;
  status?: ResourceStatus;
}

export interface BinsInput {
  /** Explicit bins, or `count` bins with the same limits (auto-coded). */
  bins?: ({ code?: string } & BinLimits)[];
  count?: number;
  maxWeightKg?: number;
  volumeM3?: number;
}

export interface BinUpdate extends Partial<BinLimits> {
  status?: ResourceStatus;
}
