import { describe, expect, it } from 'vitest';
import {
  docNo,
  fefoCompare,
  inventoryDeltas,
  kgOf,
  periodOf,
  physical,
  qrCode,
  qrPrefix,
  qualityStatus,
  zeroQty,
} from '../../src/features/stock/stock.rules.js';

describe('stock rules (D-57a)', () => {
  it('inventory deltas: only sellable and damaged changes reach inventory', () => {
    expect(inventoryDeltas('QC_HOLD', 'AVAILABLE', 5)).toEqual({ sellable: 5, damaged: 0 });
    expect(inventoryDeltas('AVAILABLE', 'RESERVED', 5)).toEqual({ sellable: 0, damaged: 0 });
    expect(inventoryDeltas('AVAILABLE', 'DAMAGED', 2)).toEqual({ sellable: -2, damaged: 2 });
    expect(inventoryDeltas('DAMAGED', 'WRITTEN_OFF', 2)).toEqual({ sellable: 0, damaged: -2 });
    expect(inventoryDeltas('PACKED', 'DISPATCHED', 3)).toEqual({ sellable: -3, damaged: 0 });
    expect(inventoryDeltas('RECEIVED', 'QC_HOLD', 9)).toEqual({ sellable: 0, damaged: 0 });
  });

  it('FEFO: earliest expiry first, unknown expiry last, then oldest receipt', () => {
    const lot = (id: string, expiry: string | null, received: string) => ({
      id,
      expiryDate: expiry === null ? null : new Date(expiry),
      receivedAt: new Date(received),
    });
    const sorted = [
      lot('c', null, '2026-01-01'),
      lot('b', '2027-03-01', '2026-02-01'),
      lot('a', '2027-01-15', '2026-03-01'),
      lot('d', '2027-03-01', '2026-01-01'),
    ].sort(fefoCompare);
    expect(sorted.map((l) => l.id)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('quality status and physical on-hand (Figma 887 = 685 + 180 + 10 + 2 + 10)', () => {
    const q = {
      ...zeroQty(),
      available: 685,
      reserved: 180,
      qcHold: 10,
      damaged: 2,
      quarantined: 10,
    };
    expect(physical(q)).toBe(887);
    expect(qualityStatus(q)).toBe('PARTIALLY_HOLD');
    expect(qualityStatus({ ...zeroQty(), qcHold: 4 })).toBe('ON_HOLD');
    expect(qualityStatus({ ...zeroQty(), available: 4 })).toBe('RELEASED');
    expect(qualityStatus(zeroQty())).toBe('EMPTY');
  });

  it('document numbers, QR codes, kg', () => {
    expect(docNo('CN', 2611, 7)).toBe('CN-2611-0007');
    expect(periodOf(new Date('2026-11-30T20:00:00Z'))).toBe(2612); // IST is already 1 Dec
    expect(qrCode(qrPrefix('lf/2608', 'LF-050', false), 1)).toBe('FX-LF-2608-0001');
    expect(qrCode(qrPrefix('LF-2608', 'LF-050', true), 12345)).toBe('FX-LF-050-LF-2608-12345');
    expect(kgOf(3, 50_000)).toBe(150);
    expect(kgOf(3, null)).toBeNull();
  });
});
