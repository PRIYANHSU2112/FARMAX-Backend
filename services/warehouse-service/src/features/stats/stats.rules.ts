/** Pure stats rules (no I/O; unit-tested). */

/** Change in % with 1 decimal; null when there is no base to compare with. */
export const deltaPct = (now: number, before: number | null | undefined): number | null =>
  before === null || before === undefined || before === 0
    ? null
    : Math.round(((now - before) / before) * 1000) / 10;

/** A snapshot older than three refresh intervals is stale (inventory down or the job stopped). */
export const isStale = (asOf: Date | null, now: Date, refreshSeconds: number): boolean =>
  asOf === null || now.getTime() - asOf.getTime() > 3 * refreshSeconds * 1000;

export interface BoardInput {
  status: 'SETUP' | 'ACTIVE' | 'LIMITED' | 'INACTIVE';
  /** Today after a holiday is applied. */
  today: { isOpen: boolean; limitedHoliday: boolean };
  coldZones: { total: number; active: number };
  asOf: Date | null;
  now: Date;
}

export interface BoardRow {
  key: 'RECEIVING_DISPATCH' | 'COLD_STORAGE' | 'SYSTEM_SYNC';
  label: string;
  state:
    | 'OPERATIONAL'
    | 'LIMITED'
    | 'CLOSED_TODAY'
    | 'INACTIVE'
    | 'MAINTENANCE'
    | 'NOT_CONFIGURED'
    | 'CONNECTED'
    | 'DELAYED'
    | 'NO_DATA';
  detail: string | null;
}

const SYNC_FRESH_MS = 2 * 60 * 1000;

/** W2.03 "Status" board, derived from facts the service owns. */
export function statusBoard(i: BoardInput): BoardRow[] {
  let ops: BoardRow['state'] = 'OPERATIONAL';
  if (i.status === 'SETUP' || i.status === 'INACTIVE') ops = 'INACTIVE';
  else if (!i.today.isOpen) ops = 'CLOSED_TODAY';
  else if (i.status === 'LIMITED' || i.today.limitedHoliday) ops = 'LIMITED';

  let cold: BoardRow['state'] = 'NOT_CONFIGURED';
  if (i.coldZones.total > 0) cold = i.coldZones.active > 0 ? 'OPERATIONAL' : 'MAINTENANCE';

  let sync: BoardRow['state'] = 'NO_DATA';
  if (i.asOf !== null)
    sync = i.now.getTime() - i.asOf.getTime() < SYNC_FRESH_MS ? 'CONNECTED' : 'DELAYED';

  return [
    { key: 'RECEIVING_DISPATCH', label: 'Receiving & Dispatch', state: ops, detail: null },
    {
      key: 'COLD_STORAGE',
      label: 'Cold Storage (2–8 °C)',
      state: cold,
      detail:
        i.coldZones.total > 0
          ? `${String(i.coldZones.active)} of ${String(i.coldZones.total)} cold zones active`
          : null,
    },
    {
      key: 'SYSTEM_SYNC',
      label: 'System Sync (OMS)',
      state: sync,
      detail: i.asOf === null ? null : `Last sync ${i.asOf.toISOString()}`,
    },
  ];
}
