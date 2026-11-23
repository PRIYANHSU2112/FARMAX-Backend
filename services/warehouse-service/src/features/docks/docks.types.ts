import type { TempClass } from '../warehouses/index.js';

export type DockType = 'UNLOADING' | 'LOADING' | 'BOTH';
export type VehicleClass = 'MINI_TRUCK' | 'TRUCK' | 'HEAVY_TRUCK' | 'ANY';
export type CapacityUnit = 'TONNES' | 'PALLETS';
export type Direction = 'INBOUND' | 'OUTBOUND';
export type BookingStatus = 'PLANNED' | 'IN_USE' | 'DONE' | 'CANCELLED';
export type ResourceStatus = 'ACTIVE' | 'INACTIVE' | 'MAINTENANCE';

export interface DoorInput {
  code: string;
  name: string;
  type: DockType;
  vehicleClass: VehicleClass;
  capacityPerDay: number;
  capacityUnit: CapacityUnit;
  opensAt?: string | null;
  closesAt?: string | null;
  status?: ResourceStatus;
}

export interface DoorUpdate extends Partial<Omit<DoorInput, 'code'>> {
  expectedVersion: number;
}

/** W2.07 dock doors table. */
export interface DoorView {
  id: string;
  code: string;
  name: string;
  type: DockType;
  vehicleClass: VehicleClass;
  capacityPerDay: string;
  capacityUnit: CapacityUnit;
  opensAt: string | null;
  closesAt: string | null;
  status: ResourceStatus;
  /** AVAILABLE · BUSY (a booking is IN_USE now) · INACTIVE · MAINTENANCE */
  displayStatus: 'AVAILABLE' | 'BUSY' | 'INACTIVE' | 'MAINTENANCE';
  /** The IN_USE booking: "INB-1045 (8 Ton)". */
  currentUse: { bookingId: string; refNo: string; loadQty: string; loadUnit: CapacityUnit } | null;
  version: number;
}

export interface BookingInput {
  refNo: string;
  direction: Direction;
  /** In the door's own unit. */
  loadQty: number;
  plannedStart: string;
  plannedEnd: string;
}

export interface BookingView {
  id: string;
  dockDoorId: string;
  doorCode: string;
  direction: Direction;
  refNo: string;
  loadQty: string;
  loadUnit: CapacityUnit;
  plannedStart: string;
  plannedEnd: string;
  status: BookingStatus;
  startedAt: string | null;
  endedAt: string | null;
}

export interface StagingInput {
  name: string;
  kind: Direction | 'BOTH';
  capacityPallets: number;
  temperatureClass?: TempClass;
  status?: ResourceStatus;
}

export interface YardSlotInput {
  code: string;
  vehicleClass?: VehicleClass;
  status?: 'AVAILABLE' | 'BLOCKED';
}

/** W2.07 KPI cards. Tonnes and pallets are separate entries, never added. */
export interface DockYardSummary {
  date: string;
  doors: { total: number; active: number; busy: number; inactive: number };
  staging: { count: number; totalPallets: number };
  yard: { total: number; available: number; occupied: number; blocked: number };
  unloadingCapacity: {
    unit: CapacityUnit;
    total: string;
    planned: string;
    used: string;
    available: string;
    usedPct: number;
  }[];
}
