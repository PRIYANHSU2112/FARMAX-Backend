export type CutoffType = 'SAME_DAY_STANDARD' | 'SAME_DAY_COLD' | 'NEXT_DAY';
export const CUTOFF_TYPES: readonly CutoffType[] = [
  'SAME_DAY_STANDARD',
  'SAME_DAY_COLD',
  'NEXT_DAY',
];

export interface DayHours {
  isoDay: number;
  isOpen: boolean;
  opensAt: string | null;
  closesAt: string | null;
}

export interface ShiftInput {
  name: string;
  startsAt: string;
  endsAt: string;
  overnight?: boolean;
  breakStartsAt?: string | null;
  breakEndsAt?: string | null;
  isoDays: number[];
  teamName?: string | null;
  dockDoorIds?: string[];
  status?: 'ACTIVE' | 'INACTIVE';
}

export interface ShiftUpdate extends Partial<ShiftInput> {
  expectedVersion: number;
}

export interface HolidayInput {
  /** Local date YYYY-MM-DD. */
  date: string;
  name: string;
  reason?: string | null;
  mode: 'CLOSED' | 'LIMITED';
  limitedFrom?: string | null;
  limitedTo?: string | null;
}

export interface ShiftView {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  overnight: boolean;
  breakStartsAt: string | null;
  breakEndsAt: string | null;
  isoDays: number[];
  teamName: string | null;
  dockDoorIds: string[];
  status: string;
  version: number;
}

export interface HolidayView {
  id: string;
  date: string;
  name: string;
  reason: string | null;
  mode: 'CLOSED' | 'LIMITED';
  limitedFrom: string | null;
  limitedTo: string | null;
}

/** W2.09 screen in one call: KPIs, weekly grid, cut-offs, shifts, holidays. */
export interface CalendarView {
  warehouseId: string;
  timezone: string;
  today: {
    date: string;
    isoDay: number;
    /** Hours today after a holiday (closed or limited) is applied. */
    isOpen: boolean;
    opensAt: string | null;
    closesAt: string | null;
    holiday: HolidayView | null;
    activeShifts: number;
    shiftNames: string[];
  };
  operatingHours: DayHours[];
  cutoffs: { type: CutoffType; cutoffTime: string | null }[];
  shifts: ShiftView[];
  holidays: HolidayView[];
  upcomingHolidays: { count: number; next: HolidayView | null };
}
