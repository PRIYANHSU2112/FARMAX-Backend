import type { BoardRow } from './stats.rules.js';

/** Root category id stored for stock that has no category yet. */
export const UNCLASSIFIED = '00000000-0000-0000-0000-000000000000';

export interface CurrentRow {
  warehouseId: string;
  onHand: number;
  reserved: number;
  damaged: number;
  available: number;
  skuCount: number;
  usedKg: string;
  weighedUnits: number;
  unweighedUnits: number;
  unweighedSkus: number;
  weightKnownPct: string;
  asOf: Date;
}

export interface CategoryRow {
  warehouseId: string;
  rootCategoryId: string;
  skuCount: number;
  onHand: number;
  reserved: number;
  available: number;
}

export interface DailyRow {
  warehouseId: string;
  day: string;
  onHand: number;
  available: number;
  reserved: number;
  openOrders: number;
}

/** Stock + weight figures of one warehouse for list rows, summary and the details header. */
export interface StockFigures {
  onHand: number;
  available: number;
  reserved: number;
  damaged: number;
  skuCount: number;
  usedKg: string;
  weightKnownPct: number;
  unweighedSkus: number;
  asOf: string;
  /** Older than three refresh intervals (inventory down or the job stopped). */
  stale: boolean;
}

interface Trend {
  value: number;
  /** vs the same figure 7 days ago (null without history). */
  vsLast7DaysPct: number | null;
}

/** W2.03 Overview cards. Figures whose module does not exist yet are null (see `modules`). */
export interface OverviewView {
  warehouseId: string;
  asOf: string | null;
  stale: boolean;
  stock: { onHand: Trend; available: Trend; reserved: Trend; skuCount: number };
  activeOrders: {
    new: number;
    allocated: number;
    total: number;
    inPicking: null;
    inPacking: null;
    readyToDispatch: null;
  };
  ordersToProcess: { count: number; vsYesterdayPct: number | null };
  transfers: { inbound: null; outbound: null };
  onTimeDispatchPct: null;
  performance: {
    otifPct: null;
    pickAccuracyPct: null;
    dockToStockHours: null;
    cycleTimeHours: null;
  };
  capacity: {
    totalKg: string | null;
    usedKg: string | null;
    availableKg: string | null;
    usedPct: number | null;
    weightKnownPct: number | null;
    unweighedSkus: number | null;
  };
  statusBoard: BoardRow[];
  info: {
    typeLabel: string;
    serviceArea: {
      stateCodes: string[];
      stateNames: string[];
      districts: number;
      pinCodes: number;
    };
    operatingHoursToday: {
      isOpen: boolean;
      opensAt: string | null;
      closesAt: string | null;
      holiday: string | null;
    };
    updatedAt: string;
  };
  modules: { transfers: false; picking: false; performance: false; nearExpiry: false };
}

export interface CategoryStockView {
  rootCategoryId: string | null;
  /** null = not classified, or the catalog could not be read. */
  name: string | null;
  skuCount: number;
  onHand: number;
  reserved: number;
  available: number;
  /** Share of on-hand units (donut), 1 decimal. */
  sharePct: number;
  /** Needs batches / expiry (not built). */
  nearExpiry: null;
}

export interface StockByCategoryView {
  warehouseId: string;
  asOf: string | null;
  stale: boolean;
  totals: { skuCount: number; onHand: number; reserved: number; available: number };
  /** SKUs with no pack weight (excluded from capacity kg); give the list to the product team. */
  unweighedSkus: number;
  categories: CategoryStockView[];
  modules: { nearExpiry: false };
}
