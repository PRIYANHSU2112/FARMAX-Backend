import { describe, expect, it } from 'vitest';

import { contextFromRows } from '../../src/adapters/catalog-client.js';
import {
  effectiveAttributes,
  mergeCompliance,
  validateAttributeValues,
} from '../../src/features/attributes/attributes.rules.js';
import type {
  AttributeDef,
  ComplianceFlags,
} from '../../src/features/attributes/attributes.types.js';
import {
  type ComplianceSubject,
  checkCompliance,
  normalizeRegulatory,
} from '../../src/features/products/products.compliance.js';
import {
  buildSearchText,
  discountOf,
  firstFreeSlug,
  pickDefaultIndex,
  pickPromotion,
  priceSummary,
  productCodeOf,
  slugify,
} from '../../src/features/products/products.helpers.js';
import { isDeletable, nextStatus } from '../../src/features/products/products.status.js';
import { parseAttrFilters } from '../../src/features/products/products.storefront.js';

const NO_PROFILE: ComplianceFlags = {
  requiresRegistration: false,
  requiresDrugLicense: false,
  requiresManufacturingLicense: false,
  requiresWithdrawal: false,
  requiresColdChain: false,
  requiredDocTypes: [],
  allowedSchedules: [],
};

const subject = (over: Partial<ComplianceSubject> = {}): ComplianceSubject => ({
  drugSchedule: 'OTC',
  registrationAuthority: null,
  registrationNo: null,
  drugLicenseNo: null,
  manufacturingLicenseNo: null,
  isPrescriptionRequired: false,
  isVetConsultRequired: false,
  isAntimicrobial: false,
  genericName: null,
  manufacturerName: 'Venky’s (India) Ltd.',
  ingredientCount: 0,
  species: [],
  withdrawalMeatDays: null,
  withdrawalEggDays: null,
  temperatureClass: 'AMB',
  storageMinTempC: null,
  storageMaxTempC: null,
  storageInstructions: null,
  hazardClass: null,
  unNumber: null,
  docTypes: [],
  hasPrimaryImage: true,
  hasActiveDefaultVariant: true,
  ...over,
});
const rules = (s: ComplianceSubject, p: ComplianceFlags = NO_PROFILE) =>
  checkCompliance(s, p).map((i) => `${i.rule}:${i.path}`);

describe('regulatory matrix', () => {
  it('a plain OTC ambient product with image and default variant passes', () => {
    expect(rules(subject())).toEqual([]);
  });

  it('R1: Schedule H needs Rx, drug + manufacturing licence and registration', () => {
    expect(rules(subject({ drugSchedule: 'H' }))).toEqual([
      'R1:isPrescriptionRequired',
      'R1:drugLicenseNo',
      'R1:manufacturingLicenseNo',
      'R1:registrationNo',
      'R1:registrationAuthority',
    ]);
  });

  it('R2/R3: Schedule G and X specifics', () => {
    expect(rules(subject({ drugSchedule: 'G', isPrescriptionRequired: true }))).toContain(
      'R2:manufacturingLicenseNo',
    );
    expect(rules(subject({ drugSchedule: 'X' }))).toContain('R3:isVetConsultRequired');
  });

  it('R4: category profile tightens OTC licensing and allowed schedules', () => {
    const profile = { ...NO_PROFILE, requiresRegistration: true, allowedSchedules: ['H' as const] };
    expect(rules(subject(), profile)).toEqual([
      'R4:registrationNo',
      'R4:registrationAuthority',
      'R4:drugSchedule',
    ]);
  });

  it('R5/R6: withdrawal periods by species when antimicrobial or required (0 is valid)', () => {
    const layer = { producesMeat: true, producesEggs: true };
    const base = {
      isAntimicrobial: true,
      drugSchedule: 'H' as const,
      isPrescriptionRequired: true,
      genericName: 'Enrofloxacin',
      ingredientCount: 1,
      drugLicenseNo: 'x',
      manufacturingLicenseNo: 'y',
      registrationNo: 'z',
      registrationAuthority: 'CDSCO',
    };
    expect(rules(subject({ ...base, species: [] }))).toEqual(['R5:speciesIds']);
    expect(rules(subject({ ...base, species: [layer] }))).toEqual([
      'R5:withdrawalMeatDays',
      'R6:withdrawalEggDays',
    ]);
    expect(
      rules(subject({ ...base, species: [layer], withdrawalMeatDays: 0, withdrawalEggDays: 7 })),
    ).toEqual([]);
    const broilerOnly = { ...NO_PROFILE, requiresWithdrawal: true };
    expect(
      rules(subject({ species: [{ producesMeat: true, producesEggs: false }] }), broilerOnly),
    ).toEqual(['R5:withdrawalMeatDays']);
  });

  it('R7: antimicrobials are never OTC and need generic name + ingredient', () => {
    // Antimicrobials also need species (to decide withdrawal periods, R5).
    expect(rules(subject({ isAntimicrobial: true }))).toEqual([
      'R5:speciesIds',
      'R7:drugSchedule',
      'R7:genericName',
      'R7:ingredients',
    ]);
  });

  it('R8–R10: temperature classes', () => {
    expect(
      rules(
        subject({
          temperatureClass: 'CC_REF',
          storageInstructions: '2–8 °C',
          storageMinTempC: 2,
          storageMaxTempC: 8,
        }),
      ),
    ).toEqual([]);
    expect(
      rules(
        subject({
          temperatureClass: 'CC_REF',
          storageInstructions: 'x',
          storageMinTempC: 0,
          storageMaxTempC: 10,
        }),
      ),
    ).toEqual(['R8:storageMinTempC', 'R8:storageMaxTempC']);
    expect(
      rules(subject({ temperatureClass: 'CC_FRZ', storageInstructions: 'x', storageMaxTempC: -5 })),
    ).toEqual(['R9:storageMaxTempC']);
    expect(
      rules(
        subject({ temperatureClass: 'AMB_CTL', storageInstructions: 'x', storageMaxTempC: 35 }),
      ),
    ).toEqual(['R10:storageMaxTempC']);
    expect(rules(subject(), { ...NO_PROFILE, requiresColdChain: true })).toEqual([
      'R8:temperatureClass',
    ]);
  });

  it('R11: hazardous goods need SDS, hazard class, UN number and handling', () => {
    expect(rules(subject({ temperatureClass: 'HAZ' }))).toEqual([
      'R11:media',
      'R11:hazardClass',
      'R11:unNumber',
      'R11:storageInstructions',
    ]);
    expect(
      rules(
        subject({
          temperatureClass: 'HAZ',
          docTypes: ['MSDS'],
          hazardClass: 'Corrosive 8',
          unNumber: 'UN1760',
          storageInstructions: 'x',
        }),
      ),
    ).toEqual([]);
  });

  it('R12/R13: category documents, primary image, default variant, manufacturer', () => {
    const profile = { ...NO_PROFILE, requiredDocTypes: ['LEAFLET' as const] };
    expect(
      rules(
        subject({ hasPrimaryImage: false, hasActiveDefaultVariant: false, manufacturerName: null }),
        profile,
      ),
    ).toEqual(['R12:media', 'R13:media', 'R13:variants', 'R13:manufacturerName']);
  });

  it('normalizeRegulatory forces Rx for G/H/H1/X and antimicrobials, vet consult for X', () => {
    const base = {
      isAntimicrobial: false,
      isPrescriptionRequired: false,
      isVetConsultRequired: false,
    };
    expect(
      normalizeRegulatory({ ...base, drugSchedule: 'OTC' as const }).isPrescriptionRequired,
    ).toBe(false);
    expect(
      normalizeRegulatory({ ...base, drugSchedule: 'H1' as const }).isPrescriptionRequired,
    ).toBe(true);
    expect(normalizeRegulatory({ ...base, drugSchedule: 'X' as const }).isVetConsultRequired).toBe(
      true,
    );
    expect(
      normalizeRegulatory({ ...base, drugSchedule: 'OTC' as const, isAntimicrobial: true })
        .isPrescriptionRequired,
    ).toBe(true);
  });
});

describe('status machine', () => {
  it('allows only the documented transitions', () => {
    expect(nextStatus('DRAFT', 'submit')).toBe('PENDING_REVIEW');
    expect(nextStatus('PENDING_REVIEW', 'approve')).toBe('PUBLISHED');
    expect(nextStatus('PENDING_REVIEW', 'reject')).toBe('DRAFT');
    expect(nextStatus('PUBLISHED', 'suspend')).toBe('SUSPENDED');
    expect(nextStatus('SUSPENDED', 'reinstate')).toBe('PUBLISHED');
    expect(nextStatus('PUBLISHED', 'discontinue')).toBe('DISCONTINUED');
    expect(nextStatus('DRAFT', 'approve')).toBeNull();
    expect(nextStatus('DISCONTINUED', 'discontinue')).toBeNull();
    expect(isDeletable('PUBLISHED')).toBe(false);
    expect(isDeletable('DISCONTINUED')).toBe(true);
  });
});

describe('helpers', () => {
  it('discount is derived from MRP and the projected selling price', () => {
    expect(discountOf('1150.00', '980.00')).toEqual({
      discountAmount: '170.00',
      discountPercent: 14.78,
    });
    expect(discountOf('100', null)).toEqual({ discountAmount: null, discountPercent: null });
    expect(discountOf('100', '120')).toEqual({ discountAmount: '0.00', discountPercent: 0 });
  });

  it('price summary over priced variants only', () => {
    expect(
      priceSummary([
        { mrp: '185', sellingPrice: '162' },
        { mrp: '1150', sellingPrice: '980' },
        { mrp: '50', sellingPrice: null },
      ]),
    ).toEqual({
      minPrice: '162.00',
      maxPrice: '980.00',
      maxDiscountPercent: '14.78',
    });
    expect(priceSummary([{ mrp: '50', sellingPrice: null }]).minPrice).toBeNull();
  });

  it('default-variant invariant on create', () => {
    expect(pickDefaultIndex([{}, {}])).toBe(0);
    expect(pickDefaultIndex([{ isActive: false }, {}])).toBe(1);
    expect(pickDefaultIndex([{}, { isDefault: true }])).toBe(1);
    expect(pickDefaultIndex([{ isDefault: true }, { isDefault: true }])).toMatch(/Only one/);
    expect(pickDefaultIndex([{ isDefault: true, isActive: false }])).toMatch(/must be active/);
    expect(pickDefaultIndex([{ isActive: false }])).toMatch(/At least one/);
  });

  it('promotion picks the lowest sort order active variant, or the requested one', () => {
    const vs = [
      { id: 'a', isActive: true, sortOrder: 10 },
      { id: 'b', isActive: false, sortOrder: 5 },
      { id: 'c', isActive: true, sortOrder: 20 },
    ];
    expect(pickPromotion(vs, 'a')?.id).toBe('c');
    expect(pickPromotion(vs, 'c')?.id).toBe('a');
    expect(pickPromotion(vs, 'a', 'b')).toBeUndefined();
  });

  it('slugs, codes and search text', () => {
    expect(slugify('Enrocin 10% Oral Solution')).toBe('enrocin-10-pct-oral-solution');
    expect(firstFreeSlug('x', new Set(['x', 'x-2']))).toBe('x-3');
    expect(productCodeOf(123n)).toBe('FXP-000123');
    expect(
      buildSearchText({
        name: 'Enrocin',
        genericName: 'Enrofloxacin',
        brandName: 'Venky’s',
        productCode: 'FXP-1',
        manufacturerName: null,
        tags: ['CRD'],
        ingredientNames: ['Enrofloxacin'],
      }),
    ).toBe('enrocin enrofloxacin venky’s fxp-1 enrofloxacin crd');
  });
});

const def = (key: string, categoryId: string, over: Partial<AttributeDef> = {}): AttributeDef => ({
  id: `${categoryId}-${key}`,
  categoryId,
  key,
  label: key,
  dataType: 'TEXT',
  unit: null,
  options: [],
  isRequired: false,
  isFilterable: false,
  sortOrder: 0,
  version: 0,
  ...over,
});

describe('dynamic attributes', () => {
  it('inherit down the path; a deeper category overrides a key', () => {
    const eff = effectiveAttributes(
      ['root', 'child'],
      [
        def('strain', 'root', { dataType: 'SELECT', options: ['Lasota'] }),
        def('strain', 'child', { dataType: 'SELECT', options: ['Lasota', 'F1'] }),
        def('doses', 'root', { dataType: 'NUMBER' }),
        def('other', 'elsewhere'),
      ],
    );
    expect(eff.map((a) => [a.key, a.categoryId, a.inherited])).toEqual([
      ['doses', 'root', true],
      ['strain', 'child', false],
    ]);
  });

  it('validates types, options, required and unknown keys', () => {
    const defs = effectiveAttributes(
      ['c'],
      [
        def('strain', 'c', { dataType: 'SELECT', options: ['Lasota', 'F1'], isRequired: true }),
        def('doses', 'c', { dataType: 'NUMBER' }),
        def('routes', 'c', { dataType: 'MULTI_SELECT', options: ['eye', 'water'] }),
        def('expiry', 'c', { dataType: 'DATE' }),
      ],
    );
    expect(
      validateAttributeValues(defs, {
        strain: 'Lasota',
        doses: 1000,
        routes: ['eye'],
        expiry: '2027-01-31',
      }),
    ).toEqual([]);
    expect(
      validateAttributeValues(defs, {
        doses: '1000',
        routes: ['oral'],
        expiry: '31/01/2027',
        colour: 'red',
      }).map((i) => i.path),
    ).toEqual([
      'attributes.colour',
      'attributes.doses',
      'attributes.expiry',
      'attributes.routes',
      'attributes.strain',
    ]);
    expect(validateAttributeValues(defs, {}, { enforceRequired: false })).toEqual([]);
  });

  it('compliance profiles merge tighten-only along the path', () => {
    const merged = mergeCompliance([
      {
        ...NO_PROFILE,
        requiresDrugLicense: true,
        requiredDocTypes: ['LEAFLET'],
        allowedSchedules: ['G', 'H'],
      },
      {
        ...NO_PROFILE,
        requiresColdChain: true,
        requiredDocTypes: ['PACKAGE_INSERT'],
        allowedSchedules: ['H', 'H1'],
      },
    ]);
    expect(merged).toMatchObject({
      requiresDrugLicense: true,
      requiresColdChain: true,
      allowedSchedules: ['H'],
    });
    expect(merged.requiredDocTypes).toEqual(['LEAFLET', 'PACKAGE_INSERT']);
  });

  it('storefront attr filters accept filterable keys only, coerced by type', () => {
    const defs = effectiveAttributes(
      ['c'],
      [
        def('strain', 'c', { dataType: 'SELECT', options: ['Lasota'], isFilterable: true }),
        def('doses', 'c', { dataType: 'NUMBER', isFilterable: true }),
        def('secret', 'c'),
      ],
    );
    expect(
      parseAttrFilters({ 'attr.strain': 'Lasota', 'attr.doses': ['1000', '2000'], q: 'x' }, defs),
    ).toEqual([
      { key: 'strain', values: ['Lasota'], multi: false },
      { key: 'doses', values: [1000, 2000], multi: false },
    ]);
    expect(() => parseAttrFilters({ 'attr.secret': 'x' }, defs)).toThrow();
  });
});

describe('catalog snapshot', () => {
  const rows = [
    { id: 'r', parentId: null, path: '/r/', name: 'Medicines', slug: 'medicines', isActive: true },
    {
      id: 'a',
      parentId: 'r',
      path: '/r/a/',
      name: 'Antibiotics',
      slug: 'antibiotics',
      isActive: false,
    },
    {
      id: 'f',
      parentId: 'a',
      path: '/r/a/f/',
      name: 'Fluoroquinolones',
      slug: 'fq',
      isActive: true,
    },
  ];
  it('builds path, breadcrumb, subtree and effective activity', () => {
    expect(contextFromRows(rows, 'f')).toMatchObject({
      pathIds: ['r', 'a', 'f'],
      breadcrumb: [{ slug: 'medicines' }, { slug: 'antibiotics' }, { slug: 'fq' }],
      effectiveActive: false,
      subtreeIds: ['f'],
    });
    expect(contextFromRows(rows, 'r')?.subtreeIds).toEqual(['r', 'a', 'f']);
    expect(contextFromRows(rows, 'nope')).toBeNull();
  });
});
