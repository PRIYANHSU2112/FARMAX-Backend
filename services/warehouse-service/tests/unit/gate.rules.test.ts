import { describe, expect, it } from 'vitest';

import {
  type Action,
  type EntryStatus,
  FROM,
  canLinkReceipt,
  checklist,
  etagOf,
  exitCheck,
  expectedLoad,
  formatRegNo,
  initials,
  maskMobile,
  maskRef,
  minuteBucket,
  normalizeRegNo,
  reconcile,
  redeliveryDoc,
  sanitizeAudit,
  stageOf,
  stepsOf,
  transition,
} from '../../src/features/gate/gate.rules.js';
import { loadQrKeys, signPass, verifyPass } from '../../src/features/gate/gate.qr.js';

const at = (status: EntryStatus, pausedFromStatus: EntryStatus | null = null) => ({
  status,
  pausedFromStatus,
});

describe('gate state machine (D-62 §1a)', () => {
  // Every row of the §1a table.
  it.each<[Action, EntryStatus, EntryStatus]>([
    ['GROSS', 'ARRIVED', 'WEIGHED_IN'],
    ['APPROVE', 'ARRIVED', 'APPROVED'],
    ['APPROVE', 'WEIGHED_IN', 'APPROVED'],
    ['BLOCK', 'ARRIVED', 'BLOCKED'],
    ['BLOCK', 'WEIGHED_IN', 'BLOCKED'],
    ['BLOCK', 'APPROVED', 'BLOCKED'],
    ['TURN_AWAY', 'ARRIVED', 'REJECTED'],
    ['TURN_AWAY', 'WEIGHED_IN', 'REJECTED'],
    ['TURN_AWAY', 'BLOCKED', 'REJECTED'],
    ['TURN_AWAY', 'APPROVED', 'REJECTED'],
    ['HANDOVER', 'APPROVED', 'UNLOADING'],
    ['UNLOAD', 'UNLOADING', 'UNLOADED'],
    ['TARE_WITHIN', 'UNLOADED', 'WEIGHED_OUT'],
    ['TARE_HOLD', 'UNLOADED', 'HELD'],
    ['RESOLVE_ACCEPT', 'HELD', 'WEIGHED_OUT'],
    ['OUTWARD_PASS', 'WEIGHED_OUT', 'PASS_OUT'],
    ['OUTWARD_PASS', 'REJECTED', 'PASS_OUT'],
    ['EXIT', 'PASS_OUT', 'EXITED'],
    ['CANCEL', 'ARRIVED', 'CANCELLED'],
  ])('%s from %s → %s', (action, from, to) => {
    const t = transition(action, at(from));
    expect(t).toMatchObject({ ok: true, to });
  });

  it('refuses every action outside its FROM list (STALE_STATE)', () => {
    const all: EntryStatus[] = [
      'ARRIVED',
      'WEIGHED_IN',
      'APPROVED',
      'UNLOADING',
      'UNLOADED',
      'WEIGHED_OUT',
      'PASS_OUT',
      'BLOCKED',
      'HELD',
      'REJECTED',
      'EXITED',
      'CANCELLED',
    ];
    for (const [action, from] of Object.entries(FROM) as [Action, readonly EntryStatus[]][])
      for (const s of all.filter((x) => !from.includes(x)))
        expect(transition(action, at(s)), `${action} from ${s}`).toEqual({
          ok: false,
          reason: 'STALE_STATE',
        });
  });

  it('turn-away is impossible once unloading started (stock already received)', () => {
    for (const s of ['UNLOADING', 'UNLOADED', 'WEIGHED_OUT', 'HELD', 'PASS_OUT'] as const)
      expect(transition('TURN_AWAY', at(s)).ok).toBe(false);
  });

  it('BLOCK remembers where it paused and UNBLOCK resumes there', () => {
    const b = transition('BLOCK', at('WEIGHED_IN'));
    expect(b).toEqual({ ok: true, to: 'BLOCKED', pausedFromStatus: 'WEIGHED_IN' });
    expect(transition('UNBLOCK', at('BLOCKED', 'WEIGHED_IN'))).toEqual({
      ok: true,
      to: 'WEIGHED_IN',
      pausedFromStatus: null,
    });
    expect(transition('UNBLOCK', at('BLOCKED', null)).ok).toBe(false);
  });

  it('HELD accept goes to WEIGHED_OUT, never back to pausedFromStatus', () => {
    expect(transition('RESOLVE_ACCEPT', at('HELD', 'UNLOADED'))).toEqual({
      ok: true,
      to: 'WEIGHED_OUT',
      pausedFromStatus: null,
    });
  });

  it('mirrors the shipment stage, applying the turned-away action only at EXITED', () => {
    expect(stageOf('REJECTED', 'REJECTED', 'CANCEL')).toBe('REJECTED');
    expect(stageOf('EXITED', 'REJECTED', 'REEXPECT')).toBe('EXPECTED');
    expect(stageOf('EXITED', 'REJECTED', 'CANCEL')).toBe('CANCELLED');
    expect(stageOf('EXITED', 'COMPLETED', null)).toBe('COMPLETED');
    expect(stageOf('CANCELLED', null, null)).toBe('EXPECTED');
    expect(stageOf('WEIGHED_IN', null, null)).toBe('WEIGHED_IN');
  });

  it('step bar stays on the paused step and skips receiving for a turned-away truck', () => {
    const blocked = stepsOf(
      { status: 'BLOCKED', pausedFromStatus: 'WEIGHED_IN', outcome: null },
      { kind: 'BLOCKED', reason: 'INVALID_DOCUMENT', since: null },
    );
    expect(blocked.current).toBe(4);
    expect(blocked.pause?.kind).toBe('BLOCKED');
    expect(blocked.steps.slice(0, 3).every((s) => s.state === 'DONE')).toBe(true);
    const arrived = stepsOf({ status: 'ARRIVED', pausedFromStatus: null, outcome: null });
    expect(arrived.steps.map((s) => s.state).slice(0, 3)).toEqual(['DONE', 'DONE', 'CURRENT']);
    const rejected = stepsOf({ status: 'REJECTED', pausedFromStatus: null, outcome: 'REJECTED' });
    expect(rejected.steps.find((s) => s.key === 'RECEIVING')?.state).toBe('SKIPPED');
    const exited = stepsOf({ status: 'EXITED', pausedFromStatus: null, outcome: 'COMPLETED' });
    expect(exited.steps.every((s) => s.state === 'DONE')).toBe(true);
    expect(stepsOf(null).current).toBe(2);
  });

  it('links a CN only between UNLOADING and PASS_OUT (HELD by its paused status)', () => {
    expect(canLinkReceipt(at('UNLOADING'))).toBe(true);
    expect(canLinkReceipt(at('PASS_OUT'))).toBe(true);
    expect(canLinkReceipt(at('HELD', 'UNLOADED'))).toBe(true);
    expect(canLinkReceipt(at('APPROVED'))).toBe(false);
    expect(canLinkReceipt(at('EXITED'))).toBe(false);
  });
});

describe('weight math', () => {
  const tol = { pct: 0.5, minKg: 20 };
  const allowance = { pct: 1, perPalletKg: 25 };

  it('uses invoice gross when declared', () => {
    const e = expectedLoad({
      invoiceGrossKg: 5600,
      declaredNetKg: 5500,
      palletCount: 4,
      allowance,
    });
    expect(e).toMatchObject({
      basis: 'INVOICE_GROSS',
      expectedLoadKg: 5600,
      packagingAllowanceKg: 0,
    });
  });

  it('else net + packaging allowance (pct of net + pallets)', () => {
    const e = expectedLoad({
      invoiceGrossKg: null,
      declaredNetKg: 5000,
      palletCount: 2,
      allowance,
    });
    expect(e).toMatchObject({
      basis: 'NET_PLUS_PACKAGING',
      packagingAllowanceKg: 100,
      expectedLoadKg: 5100,
    });
  });

  it('null when nothing is declared (→ HELD NO_DECLARED_WEIGHT, never a silent pass)', () => {
    expect(
      expectedLoad({ invoiceGrossKg: null, declaredNetKg: null, palletCount: null, allowance }),
    ).toBeNull();
    const r = reconcile({ grossKg: 14250, tareKg: 8750, expected: null, tolerance: tol });
    expect(r.result).toBe('NO_DECLARED_WEIGHT');
    expect(r.measuredNetKg).toBe(5500);
  });

  it('within tolerance = |net − expected| ≤ max(pct × expected, minKg)', () => {
    const exp = expectedLoad({
      invoiceGrossKg: null,
      declaredNetKg: 5445.54,
      palletCount: 0,
      allowance,
    });
    const ok = reconcile({ grossKg: 14250, tareKg: 8750, expected: exp, tolerance: tol });
    expect(ok.result).toBe('WITHIN');
    const breach = reconcile({
      grossKg: 14100,
      tareKg: 8750,
      expected: {
        basis: 'INVOICE_GROSS',
        declaredNetKg: null,
        packagingAllowanceKg: 0,
        expectedLoadKg: 5500,
      },
      tolerance: tol,
    });
    expect(breach).toMatchObject({
      measuredNetKg: 5350,
      varianceKg: -150,
      toleranceKg: 27.5,
      result: 'BREACH',
    });
    const small = reconcile({
      grossKg: 1010,
      tareKg: 900,
      expected: {
        basis: 'INVOICE_GROSS',
        declaredNetKg: null,
        packagingAllowanceKg: 0,
        expectedLoadKg: 100,
      },
      tolerance: tol,
    });
    expect(small.toleranceKg).toBe(20);
  });

  it('exit check of a turned-away truck uses the same tolerance against gross', () => {
    expect(exitCheck(14250, 14240, tol).result).toBe('WITHIN');
    expect(exitCheck(14250, 13900, tol)).toMatchObject({
      result: 'MISMATCH',
      differenceKg: -350,
      allowedKg: 71.25,
    });
  });
});

describe('documents', () => {
  const today = '2026-11-25';
  it('re-delivery: vehicle-bound and expired reset, rejected stays, others carry forward', () => {
    expect(
      redeliveryDoc({ docType: 'RC_BOOK', status: 'VERIFIED', validUntil: null }, today),
    ).toEqual({ status: 'PENDING', expired: false, carriedForward: false });
    expect(
      redeliveryDoc({ docType: 'EWAY_BILL', status: 'VERIFIED', validUntil: '2026-12-01' }, today)
        .status,
    ).toBe('PENDING');
    expect(
      redeliveryDoc({ docType: 'INVOICE', status: 'VERIFIED', validUntil: '2026-11-20' }, today),
    ).toEqual({ status: 'PENDING', expired: true, carriedForward: false });
    expect(
      redeliveryDoc({ docType: 'PURCHASE_ORDER', status: 'VERIFIED', validUntil: null }, today),
    ).toEqual({ status: 'VERIFIED', expired: false, carriedForward: true });
    expect(
      redeliveryDoc({ docType: 'DELIVERY_CHALLAN', status: 'REJECTED', validUntil: null }, today)
        .status,
    ).toBe('REJECTED');
  });

  it('checklist KPIs + hints; an expired e-way bill blocks approval', () => {
    const required = ['PURCHASE_ORDER', 'DELIVERY_CHALLAN', 'EWAY_BILL'] as const;
    const c = checklist(
      required,
      [
        { docType: 'PURCHASE_ORDER', status: 'VERIFIED', required: true, validUntil: null },
        { docType: 'DELIVERY_CHALLAN', status: 'VERIFIED', required: true, validUntil: null },
        { docType: 'EWAY_BILL', status: 'PENDING', required: true, validUntil: '2026-11-28' },
      ],
      today,
    );
    expect(c).toMatchObject({ required: 3, verified: 2, pending: 1, blocked: 0, complete: false });
    expect(c.hint.title).toBe('One document requires confirmation');
    const expired = checklist(
      ['EWAY_BILL'],
      [{ docType: 'EWAY_BILL', status: 'VERIFIED', required: true, validUntil: '2026-11-24' }],
      today,
    );
    expect(expired.ewayExpired).toBe(true);
    expect(expired.complete).toBe(false);
    const exempt = checklist(
      ['EWAY_BILL'],
      [{ docType: 'EWAY_BILL', status: 'EXEMPTED', required: true, validUntil: null }],
      today,
    );
    expect(exempt.complete).toBe(true);
  });
});

describe('masks, plates, audit sanitizer, cache bucket', () => {
  it('normalizes and formats plates', () => {
    expect(normalizeRegNo('ap 37 bc-2210')).toBe('AP37BC2210');
    expect(formatRegNo('AP37BC2210')).toBe('AP 37 BC 2210');
    expect(formatRegNo('22BH1234AA')).toBe('22BH1234AA');
  });

  it('masks mobiles, documents and names', () => {
    expect(maskMobile('+91 98765 43210')).toBe('+91 98••• ••210');
    expect(maskRef('AP0920230012345')).toBe('••••••••2345');
    expect(initials('Rajesh  Kumar')).toBe('R. K.');
  });

  it('sanitizes driver PII before an audit row is written', () => {
    const out = sanitizeAudit({
      driverName: 'Rajesh Kumar',
      driverMobile: '+919876543210',
      driverLicenceNo: 'AP0920230012345',
      nested: [
        { docType: 'DRIVER_LICENCE', refNo: 'AP0920230012345' },
        { docType: 'INVOICE', refNo: 'INV-77' },
      ],
    });
    expect(out.driverMobile).toBe('+91 98••• ••210');
    expect(out.driverLicenceNo).toBe('••••••••2345');
    expect(out.nested[0]?.refNo).toBe('••••••••2345');
    expect(out.nested[1]?.refNo).toBe('INV-77');
  });

  it('ETag and cache key share the minute bucket', () => {
    const t = Date.UTC(2026, 10, 25, 10, 0, 30);
    expect(minuteBucket(t)).toBe(minuteBucket(t + 29_000));
    expect(minuteBucket(t)).not.toBe(minuteBucket(t + 31_000));
    expect(etagOf('7', minuteBucket(t), 'abc')).toBe(`W/"g7-${String(minuteBucket(t))}-abc"`);
  });
});

describe('gate pass QR (kid rotation, expiry, tamper)', () => {
  const old = 'o'.repeat(40);
  const cur = 'n'.repeat(40);
  const keys = loadQrKeys({
    GATE_PASS_QR_KEYS: JSON.stringify({ k1: old, k2: cur }),
    GATE_PASS_QR_ACTIVE_KID: 'k2',
  });
  const claims = {
    v: 1 as const,
    kid: 'k1',
    passId: 'p',
    passNo: 'GPI-2611-0001',
    entryId: 'e',
    wh: 'w',
    type: 'INWARD' as const,
    exp: 2_000_000_000,
  };

  it('verifies a pass signed with an older kid (rotation)', () => {
    if (keys === null) throw new Error('keys');
    expect(keys.activeKid).toBe('k2');
    const token = signPass(claims, keys);
    expect(verifyPass(token, keys, 1_900_000_000)).toMatchObject({
      ok: true,
      claims: { passNo: 'GPI-2611-0001' },
    });
  });

  it('refuses expired, tampered and unknown-key tokens', () => {
    if (keys === null) throw new Error('keys');
    const token = signPass(claims, keys);
    expect(verifyPass(token, keys, 2_000_000_001)).toEqual({ ok: false, reason: 'EXPIRED' });
    const [tag, body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, passNo: 'GPI-2611-9999' })).toString(
      'base64url',
    );
    expect(verifyPass(`${tag ?? ''}.${forged}.${sig ?? ''}`, keys, 1)).toEqual({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
    const onlyNew = loadQrKeys({ GATE_PASS_QR_KEYS: JSON.stringify({ k2: cur }) });
    if (onlyNew === null) throw new Error('keys');
    expect(verifyPass(`${tag ?? ''}.${body ?? ''}.${sig ?? ''}`, onlyNew, 1)).toEqual({
      ok: false,
      reason: 'UNKNOWN_KEY',
    });
    expect(verifyPass('garbage', keys, 1)).toEqual({ ok: false, reason: 'MALFORMED' });
  });

  it('dev fallback derives one key from the service token; config errors are loud', () => {
    expect(loadQrKeys({ INTERNAL_SERVICE_TOKEN: 'x'.repeat(40) })?.activeKid).toBe('dev');
    expect(loadQrKeys({})).toBeNull();
    expect(() => loadQrKeys({ GATE_PASS_QR_KEYS: JSON.stringify({ k: 'short' }) })).toThrow();
  });
});
