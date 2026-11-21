import type { CallSettings, SettingKey } from './options.settings.js';

export const OPTION_TYPES = [
  'CHANNEL',
  'INTENT',
  'TIMEFRAME',
  'LANGUAGE',
  'CANCEL_REASON',
  'DISPOSITION',
] as const;
export type OptionType = (typeof OPTION_TYPES)[number];

/** Types that must keep ≥ 1 active row, otherwise the booking screens cannot work. */
export const REQUIRED_TYPES: ReadonlySet<OptionType> = new Set(['CHANNEL', 'LANGUAGE', 'TIMEFRAME']);

export interface OptionView {
  id: string;
  type: OptionType;
  code: string;
  label: string;
  icon: string | null;
  sortOrder: number;
  isActive: boolean;
  meta: Record<string, unknown> | null;
  updatedAt: Date;
}

/** Active options per type (sorted) + typed settings: the read model other features use. */
export interface ConfigSnapshot {
  options: Record<OptionType, OptionView[]>;
  settings: CallSettings;
  /** Weak ETag of the whole snapshot. */
  etag: string;
}

export interface CreateOptionInput {
  type: OptionType;
  code: string;
  label: string;
  icon?: string | null;
  sortOrder?: number;
  meta?: Record<string, unknown> | null;
}

export interface UpdateOptionInput {
  label?: string;
  icon?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  meta?: Record<string, unknown> | null;
  reason?: string;
}

export interface SettingView {
  key: SettingKey;
  value: unknown;
  updatedByUserId: string | null;
  updatedAt: Date;
}

export interface UpdateSettingInput {
  value: unknown;
  reason: string;
}
