import type { ComplianceFlags, DocType, DrugSchedule } from '../attributes/index.js';
import type { ComplianceIssue, TemperatureClass } from './products.types.js';

/** What the rule matrix needs to know about a product (assembled by the service). */
export interface ComplianceSubject {
  drugSchedule: DrugSchedule;
  registrationAuthority: string | null;
  registrationNo: string | null;
  drugLicenseNo: string | null;
  manufacturingLicenseNo: string | null;
  isPrescriptionRequired: boolean;
  isVetConsultRequired: boolean;
  isAntimicrobial: boolean;
  genericName: string | null;
  manufacturerName: string | null;
  ingredientCount: number;
  species: { producesMeat: boolean; producesEggs: boolean }[];
  withdrawalMeatDays: number | null;
  withdrawalEggDays: number | null;
  temperatureClass: TemperatureClass;
  storageMinTempC: number | null;
  storageMaxTempC: number | null;
  storageInstructions: string | null;
  hazardClass: string | null;
  unNumber: string | null;
  docTypes: DocType[];
  hasPrimaryImage: boolean;
  hasActiveDefaultVariant: boolean;
}

const RX_SCHEDULES = new Set<DrugSchedule>(['G', 'H', 'H1', 'X']);
const STRICT_RX = new Set<DrugSchedule>(['H', 'H1', 'X']);
const blank = (v: string | null) => v === null || v.trim() === '';

/**
 * Applied on every save: legal flags that follow from other fields are forced, never trusted
 * from the client (R1, R3, R7).
 */
export const normalizeRegulatory = <
  T extends {
    drugSchedule: DrugSchedule;
    isAntimicrobial: boolean;
    isPrescriptionRequired: boolean;
    isVetConsultRequired: boolean;
  },
>(
  p: T,
): T => ({
  ...p,
  isPrescriptionRequired:
    p.isPrescriptionRequired || RX_SCHEDULES.has(p.drugSchedule) || p.isAntimicrobial,
  isVetConsultRequired: p.isVetConsultRequired || p.drugSchedule === 'X',
});

/**
 * Publish-time regulatory matrix (plan §C3): base rules R1–R13 combined with the category's
 * effective compliance profile. Returns every issue at once (the admin form shows them all).
 */
export const checkCompliance = (
  p: ComplianceSubject,
  profile: ComplianceFlags,
): ComplianceIssue[] => {
  const issues: ComplianceIssue[] = [];
  const need = (rule: string, path: string, ok: boolean, message: string) => {
    if (!ok) issues.push({ rule, path, message });
  };
  const registration = (rule: string) => {
    need(rule, 'registrationNo', !blank(p.registrationNo), 'Registration number is required');
    need(
      rule,
      'registrationAuthority',
      p.registrationAuthority !== null,
      'Registration authority (CDSCO / STATE) is required',
    );
  };

  // R1 Schedule H / H1 / X: prescription + full licensing.
  if (STRICT_RX.has(p.drugSchedule)) {
    need('R1', 'isPrescriptionRequired', p.isPrescriptionRequired, 'Must be prescription-only');
    need(
      'R1',
      'drugLicenseNo',
      !blank(p.drugLicenseNo),
      `Drug licence is required for Schedule ${p.drugSchedule}`,
    );
    need(
      'R1',
      'manufacturingLicenseNo',
      !blank(p.manufacturingLicenseNo),
      'Manufacturing licence is required',
    );
    registration('R1');
  }
  // R2 Schedule G: vet supervision + manufacturing licence and registration.
  if (p.drugSchedule === 'G') {
    need(
      'R2',
      'isPrescriptionRequired',
      p.isPrescriptionRequired,
      'Schedule G needs veterinary supervision',
    );
    need(
      'R2',
      'manufacturingLicenseNo',
      !blank(p.manufacturingLicenseNo),
      'Manufacturing licence is required',
    );
    registration('R2');
  }
  // R3 Schedule X: vet consult.
  if (p.drugSchedule === 'X')
    need('R3', 'isVetConsultRequired', p.isVetConsultRequired, 'Schedule X needs a vet consult');
  // R4 Category profile licensing (also covers OTC medicines).
  if (profile.requiresRegistration) registration('R4');
  if (profile.requiresDrugLicense)
    need(
      'R4',
      'drugLicenseNo',
      !blank(p.drugLicenseNo),
      'Drug licence is required in this category',
    );
  if (profile.requiresManufacturingLicense)
    need(
      'R4',
      'manufacturingLicenseNo',
      !blank(p.manufacturingLicenseNo),
      'Manufacturing licence is required in this category',
    );
  if (profile.allowedSchedules.length > 0)
    need(
      'R4',
      'drugSchedule',
      profile.allowedSchedules.includes(p.drugSchedule),
      `Schedule must be one of ${profile.allowedSchedules.join(', ')} in this category`,
    );

  // R5/R6 Withdrawal periods for food-producing species.
  const withdrawalNeeded = profile.requiresWithdrawal || p.isAntimicrobial;
  if (withdrawalNeeded) {
    need(
      'R5',
      'speciesIds',
      p.species.length > 0,
      'Target species are required to decide withdrawal periods',
    );
    if (p.species.some((s) => s.producesMeat))
      need(
        'R5',
        'withdrawalMeatDays',
        p.withdrawalMeatDays !== null,
        'Meat withdrawal period is required (0 if none)',
      );
    if (p.species.some((s) => s.producesEggs))
      need(
        'R6',
        'withdrawalEggDays',
        p.withdrawalEggDays !== null,
        'Egg withdrawal period is required (0 if none)',
      );
  }
  // R7 Antimicrobials.
  if (p.isAntimicrobial) {
    need('R7', 'drugSchedule', p.drugSchedule !== 'OTC', 'An antimicrobial cannot be OTC');
    need('R7', 'genericName', !blank(p.genericName), 'Generic name is required for antimicrobials');
    need(
      'R7',
      'ingredients',
      p.ingredientCount > 0,
      'At least one active ingredient with strength is required',
    );
  }

  // R8–R10 Temperature classes.
  const cold = p.temperatureClass === 'CC_REF' || p.temperatureClass === 'CC_FRZ';
  if (profile.requiresColdChain)
    need('R8', 'temperatureClass', cold, 'This category must be cold chain (CC_REF or CC_FRZ)');
  if (cold || p.temperatureClass === 'AMB_CTL')
    need(
      'R8',
      'storageInstructions',
      !blank(p.storageInstructions),
      'Storage instructions are required',
    );
  if (p.temperatureClass === 'CC_REF') {
    need(
      'R8',
      'storageMinTempC',
      p.storageMinTempC !== null && p.storageMinTempC >= 2,
      'Refrigerated minimum must be ≥ 2 °C',
    );
    need(
      'R8',
      'storageMaxTempC',
      p.storageMaxTempC !== null && p.storageMaxTempC <= 8,
      'Refrigerated maximum must be ≤ 8 °C',
    );
  }
  if (p.temperatureClass === 'CC_FRZ')
    need(
      'R9',
      'storageMaxTempC',
      p.storageMaxTempC !== null && p.storageMaxTempC <= -15,
      'Frozen maximum must be ≤ −15 °C',
    );
  if (p.temperatureClass === 'AMB_CTL')
    need(
      'R10',
      'storageMaxTempC',
      p.storageMaxTempC !== null && p.storageMaxTempC <= 30,
      'Controlled-ambient maximum must be ≤ 30 °C',
    );

  // R11 Hazardous goods.
  if (p.temperatureClass === 'HAZ') {
    need(
      'R11',
      'media',
      p.docTypes.includes('SDS') || p.docTypes.includes('MSDS'),
      'A safety data sheet (SDS/MSDS) is required',
    );
    need('R11', 'hazardClass', !blank(p.hazardClass), 'GHS hazard class is required');
    need('R11', 'unNumber', !blank(p.unNumber), 'UN number is required');
    need(
      'R11',
      'storageInstructions',
      !blank(p.storageInstructions),
      'Storage / handling instructions are required',
    );
  }
  // R12 Category-required documents.
  for (const docType of profile.requiredDocTypes)
    need(
      'R12',
      'media',
      p.docTypes.includes(docType),
      `${docType} document is required in this category`,
    );

  // R13 Always.
  need('R13', 'media', p.hasPrimaryImage, 'A primary product image is required');
  need('R13', 'variants', p.hasActiveDefaultVariant, 'An active default variant is required');
  need('R13', 'manufacturerName', !blank(p.manufacturerName), 'Manufacturer name is required');
  return issues;
};
