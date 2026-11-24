/** Business settings (rows of `inventory_settings`, seeded by the migration). */
export interface InventorySettings {
  /** How long an ACTIVE reservation holds stock before the expiry job releases it. */
  reservationTtlSeconds: number;
  /** reorderLevel given to a warehouse × variant row when it is first created. */
  defaultReorderLevel: number;
  /** Max lines (variants) in one reservation request. */
  maxReservationLines: number;
  /** Allow one order to be served from several warehouses (and one variant to be split). */
  allowSplitAllocation: boolean;
  /** D-57b W3.13: hide a node's stock at or below reorderLevel × pct / 100 on the storefront (0 = off). */
  bufferFloorPct: number;
}

export type SettingKey = keyof InventorySettings;

export interface SettingsView extends InventorySettings {
  updatedAt: Date | null;
}

export type UpdateSettingsInput = Partial<InventorySettings> & { reason: string };
