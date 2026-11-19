// Public API of the attributes feature (dynamic category attributes + compliance profiles).
export { attributesModule, complianceModule } from './attributes.module.js';
export type { AttributesService } from './attributes.service.js';
export { validateAttributeValues } from './attributes.rules.js';
export { DOC_TYPES, DRUG_SCHEDULES } from './attributes.types.js';
export type {
  ComplianceFlags,
  DocType,
  DrugSchedule,
  EffectiveAttribute,
} from './attributes.types.js';
export { ADMIN_ATTRIBUTES_TAG } from './attributes.docs.js';
