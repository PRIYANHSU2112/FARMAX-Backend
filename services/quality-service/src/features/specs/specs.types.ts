import type { SpecRule } from './specs.rules.js';

export interface SpecParamInput {
  code: string;
  name: string;
  unit?: string | null;
  rule: SpecRule;
  min?: number | null;
  max?: number | null;
  expectedText?: string | null;
  critical?: boolean;
}

export interface SpecInput {
  releaseMode: 'MANUFACTURER_COA' | 'INDEPENDENT_COA';
  sampleOnReceipt: boolean;
  sampleQty: number;
  sampleUnit: string;
  defaultLabId?: string | null;
  coaValidityDays?: number | null;
  isActive: boolean;
  params: SpecParamInput[];
  reason: string;
  /** 0 when the SKU has no specification yet. */
  expectedVersion: number;
}
