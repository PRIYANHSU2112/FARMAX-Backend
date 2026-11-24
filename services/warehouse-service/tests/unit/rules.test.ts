import { describe, expect, it } from 'vitest';

import {
  needsReason,
  nextStatus,
  setupSteps,
} from '../../src/features/warehouses/warehouses.rules.js';
import type { WarehouseRecord } from '../../src/features/warehouses/warehouses.types.js';

const ready: WarehouseRecord = {
  id: 'w1',
  code: 'CW-PUN-01',
  name: 'Central Warehouse',
  type: 'MOTHER',
  status: 'SETUP',
  parentWarehouseId: null,
  managerUserId: 'u1',
  phone: '+919876543210',
  email: null,
  addressLine: 'NH-48',
  landmark: null,
  city: 'Pune',
  district: 'Pune',
  stateCode: '27',
  pinCode: '411001',
  latitude: null,
  longitude: null,
  tagline: null,
  totalAreaSqft: null,
  capacityKg: '100000.00',
  temperatureClasses: ['AMB'],
  isAllocatable: true,
  priority: 100,
  timezone: 'Asia/Kolkata',
  statusReason: null,
  statusChangedAt: null,
  activatedAt: null,
  importedAt: null,
  reviewFields: [],
  version: 0,
  coverageVersion: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('warehouse status machine', () => {
  it.each([
    ['SETUP', 'activate', 'ACTIVE'],
    ['ACTIVE', 'limit', 'LIMITED'],
    ['ACTIVE', 'deactivate', 'INACTIVE'],
    ['LIMITED', 'deactivate', 'INACTIVE'],
    ['LIMITED', 'reactivate', 'ACTIVE'],
    ['INACTIVE', 'reactivate', 'ACTIVE'],
  ] as const)('%s --%s--> %s', (from, action, to) => {
    expect(nextStatus(from, action)).toBe(to);
  });

  it.each([
    ['SETUP', 'limit'],
    ['ACTIVE', 'activate'],
    ['INACTIVE', 'limit'],
    ['ACTIVE', 'reactivate'],
  ] as const)('refuses %s --%s', (from, action) => {
    expect(nextStatus(from, action)).toBeNull();
  });

  it('needs a reason to reduce service only', () => {
    expect(needsReason('limit')).toBe(true);
    expect(needsReason('deactivate')).toBe(true);
    expect(needsReason('activate')).toBe(false);
  });
});

describe('setup checklist', () => {
  it('is complete with details and a district area', () => {
    const steps = setupSteps(ready, {
      districtAreas: 1,
      unassignedPins: 0,
      activeZones: 1,
      openDays: 5,
    });
    expect(steps.every((s) => s.done)).toBe(true);
  });

  it('lists every missing detail', () => {
    const steps = setupSteps(
      { ...ready, managerUserId: null, capacityKg: null, temperatureClasses: [] },
      { districtAreas: 1, unassignedPins: 0, activeZones: 1, openDays: 5 },
    );
    expect(steps.find((s) => s.key === 'details')?.issues).toHaveLength(3);
  });

  it('an allocatable warehouse needs PINs; imported PINs count until moved', () => {
    expect(
      setupSteps(ready, { districtAreas: 0, unassignedPins: 0, activeZones: 1, openDays: 5 })[1]
        ?.done,
    ).toBe(false);
    expect(
      setupSteps(ready, { districtAreas: 0, unassignedPins: 3, activeZones: 1, openDays: 5 })[1]
        ?.done,
    ).toBe(true);
    expect(
      setupSteps(
        { ...ready, isAllocatable: false },
        { districtAreas: 0, unassignedPins: 0, activeZones: 1, openDays: 5 },
      )[1]?.done,
    ).toBe(true);
  });

  it('needs an active zone and weekly hours', () => {
    const steps = setupSteps(ready, {
      districtAreas: 1,
      unassignedPins: 0,
      activeZones: 0,
      openDays: 0,
    });
    expect(steps.filter((s) => !s.done).map((s) => s.key)).toEqual(['storage', 'calendar']);
  });

  it('imported data still to confirm blocks the review step', () => {
    const review = setupSteps(
      { ...ready, reviewFields: ['district', 'temperatureClasses'] },
      { districtAreas: 1, unassignedPins: 0, activeZones: 1, openDays: 5 },
    ).find((s) => s.key === 'review');
    expect(review?.done).toBe(false);
    expect(review?.issues).toHaveLength(2);
  });
});
