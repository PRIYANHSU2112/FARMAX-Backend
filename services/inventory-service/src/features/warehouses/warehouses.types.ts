export type WarehouseType = 'MOTHER' | 'DEPOT';

export interface WarehouseView {
  id: string;
  code: string;
  name: string;
  type: WarehouseType;
  addressLine: string;
  city: string;
  stateCode: string;
  pinCode: string;
  isActive: boolean;
  isAllocatable: boolean;
  hasColdChain: boolean;
  priority: number;
  statusReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWarehouseInput {
  code: string;
  name: string;
  type: WarehouseType;
  addressLine: string;
  city: string;
  stateCode: string;
  pinCode: string;
  isAllocatable?: boolean;
  hasColdChain?: boolean;
  priority?: number;
}

export interface UpdateWarehouseInput {
  expectedVersion: number;
  name?: string;
  type?: WarehouseType;
  addressLine?: string;
  city?: string;
  stateCode?: string;
  pinCode?: string;
  isAllocatable?: boolean;
  hasColdChain?: boolean;
  priority?: number;
  reason?: string;
}

export interface WarehouseStatusInput {
  expectedVersion: number;
  isActive: boolean;
  reason: string;
}

export interface WarehouseListQuery {
  cursor?: string;
  limit: number;
  isActive?: boolean;
  type?: WarehouseType;
  /** Code or name prefix, case-insensitive. */
  q?: string;
}

export interface CoverageEntry {
  pinCode: string;
  priority: number;
}

export interface PutCoverageInput {
  expectedVersion: number;
  entries: CoverageEntry[];
  reason: string;
}

export interface CoverageView {
  warehouseId: string;
  version: number;
  entries: CoverageEntry[];
}

/** A warehouse that may serve a PIN, in allocation order (best first). */
export interface AllocationCandidate {
  warehouseId: string;
  code: string;
  coveragePriority: number;
  warehousePriority: number;
  hasColdChain: boolean;
}
