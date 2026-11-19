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
}

export type SettingKey = keyof InventorySettings;

export interface SettingsView extends InventorySettings {
  updatedAt: Date | null;
}

export type UpdateSettingsInput = Partial<InventorySettings> & { reason: string };
