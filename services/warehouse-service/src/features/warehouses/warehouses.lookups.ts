import type { TempClass, WarehouseStatus, WarehouseType } from './warehouses.types.js';

/**
 * States and union territories by 2-digit GST state code (the code every FarmX address uses).
 * 25 (Daman and Diu) and 28 (old Andhra Pradesh) are no longer issued.
 */
export const STATES: readonly { code: string; name: string }[] = [
  { code: '01', name: 'Jammu and Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: '27', name: 'Maharashtra' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman and Nicobar Islands' },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' },
];

const STATE_NAMES = new Map(STATES.map((s) => [s.code, s.name]));
export const STATE_CODES: readonly string[] = STATES.map((s) => s.code);
export const stateName = (code: string | null): string | null =>
  code === null ? null : (STATE_NAMES.get(code) ?? null);

/** Labels match the Figma chips ("Normal", "Cool", "Cold 2–8 °C" …). */
export const TEMP_CLASS_INFO: readonly { code: TempClass; label: string; range: string | null }[] =
  [
    { code: 'AMB', label: 'Normal (ambient)', range: null },
    { code: 'AMB_CTL', label: 'Cool (controlled ambient)', range: '15–25 °C' },
    { code: 'CC_REF', label: 'Cold', range: '2–8 °C' },
    { code: 'CC_FRZ', label: 'Frozen', range: '≤ −18 °C' },
    { code: 'HAZ', label: 'Special (hazardous)', range: null },
  ];

export const TYPE_LABELS: Record<WarehouseType, string> = {
  MOTHER: 'Central warehouse (mother)',
  DEPOT: 'C&F depot',
};

export const STATUS_LABELS: Record<WarehouseStatus, string> = {
  SETUP: 'Setup',
  ACTIVE: 'Active',
  LIMITED: 'Limited',
  INACTIVE: 'Inactive',
};
