export const ATTRIBUTE_DATA_TYPES = [
  'TEXT',
  'NUMBER',
  'BOOLEAN',
  'SELECT',
  'MULTI_SELECT',
  'DATE',
] as const;
export type AttributeDataType = (typeof ATTRIBUTE_DATA_TYPES)[number];

export const DOC_TYPES = [
  'TDS',
  'SDS',
  'MSDS',
  'LEAFLET',
  'PACKAGE_INSERT',
  'LABEL',
  'CERTIFICATE',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DRUG_SCHEDULES = ['OTC', 'G', 'H', 'H1', 'X'] as const;
export type DrugSchedule = (typeof DRUG_SCHEDULES)[number];

export interface AttributeDef {
  id: string;
  categoryId: string;
  key: string;
  label: string;
  dataType: AttributeDataType;
  unit: string | null;
  options: string[];
  isRequired: boolean;
  isFilterable: boolean;
  sortOrder: number;
  version: number;
}

export interface AttributeRecord extends AttributeDef {
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Effective definition on a category: own or inherited from the nearest ancestor. */
export interface EffectiveAttribute extends AttributeDef {
  inherited: boolean;
}

export interface CreateAttributeInput {
  categoryId: string;
  key: string;
  label: string;
  dataType: AttributeDataType;
  unit?: string | null;
  options?: string[];
  isRequired?: boolean;
  isFilterable?: boolean;
  sortOrder?: number;
  reason: string;
}

export type UpdateAttributeInput = Partial<
  Pick<
    CreateAttributeInput,
    'label' | 'unit' | 'options' | 'isRequired' | 'isFilterable' | 'sortOrder'
  >
> & { reason: string };

export interface ComplianceFlags {
  requiresRegistration: boolean;
  requiresDrugLicense: boolean;
  requiresManufacturingLicense: boolean;
  requiresWithdrawal: boolean;
  requiresColdChain: boolean;
  requiredDocTypes: DocType[];
  /** Empty = any schedule. */
  allowedSchedules: DrugSchedule[];
}

export interface ComplianceProfileRecord extends ComplianceFlags {
  id: string;
  categoryId: string;
  version: number;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export type PutComplianceProfileInput = Partial<ComplianceFlags> & { reason: string };

export interface AttributeIssue {
  path: string;
  message: string;
}
