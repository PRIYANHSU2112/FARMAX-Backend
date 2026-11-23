export type WarehouseType = 'MOTHER' | 'DEPOT';

/** The projected warehouse (D-56: warehouse-service owns the master data). */
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
  coverageVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A warehouse that may serve a PIN, in allocation order (best first). */
export interface AllocationCandidate {
  warehouseId: string;
  code: string;
  coveragePriority: number;
  warehousePriority: number;
  hasColdChain: boolean;
}

/** What the projection stores from warehouse.upserted.v1. */
export interface ProjectedWarehouse {
  id: string;
  version: number;
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
}
