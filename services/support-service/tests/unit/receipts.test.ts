import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { receiptProblem, verifyReceipt } from '../../src/adapters/upstreams.js';

const SECRET = 'x'.repeat(40);
/** Same format media-service signs (media.support.ts signReceipt). */
const sign = (payload: object, secret = SECRET) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
};
const now = Math.floor(Date.now() / 1000);
const payload = {
  purpose: 'support',
  key: 'dev/support/0193.jpg',
  uploaderId: 'u1',
  kind: 'image',
  mime: 'image/jpeg',
  size: 1000,
  fileName: 'box.jpg',
  scanStatus: 'REENCODED',
  exp: now + 3600,
};

describe('upload receipts', () => {
  it('accepts a receipt signed with the shared secret', () => {
    const p = verifyReceipt(sign(payload), SECRET);
    expect(p?.key).toBe(payload.key);
    expect(receiptProblem(p, 'u1', now, true, new Set())).toBeNull();
  });

  it('rejects a tampered body, a foreign secret and garbage', () => {
    const good = sign(payload);
    const forged = `${Buffer.from(JSON.stringify({ ...payload, uploaderId: 'u2' })).toString('base64url')}.${good.split('.')[1] ?? ''}`;
    expect(verifyReceipt(forged, SECRET)).toBeNull();
    expect(verifyReceipt(sign(payload, 'y'.repeat(40)), SECRET)).toBeNull();
    expect(verifyReceipt('nonsense', SECRET)).toBeNull();
  });

  it('refuses expired, foreign, wrong type / size, unscanned (prod) and duplicate files', () => {
    const p = { ...payload } as Parameters<typeof receiptProblem>[0] & object;
    expect(receiptProblem({ ...p, exp: now - 1 }, 'u1', now, false, new Set())).toMatch(/expired/);
    expect(receiptProblem(p, 'someone-else', now, false, new Set())).toMatch(/not uploaded by you/);
    expect(receiptProblem({ ...p, purpose: 'avatar' }, 'u1', now, false, new Set())).toMatch(
      /not uploaded by you/,
    );
    expect(receiptProblem({ ...p, mime: 'video/mp4' }, 'u1', now, false, new Set())).toMatch(
      /JPEG/,
    );
    expect(receiptProblem({ ...p, size: 11 * 1024 * 1024 }, 'u1', now, false, new Set())).toMatch(
      /10 MB/,
    );
    expect(receiptProblem({ ...p, scanStatus: 'UNSCANNED' }, 'u1', now, true, new Set())).toMatch(
      /virus/,
    );
    expect(
      receiptProblem({ ...p, scanStatus: 'UNSCANNED' }, 'u1', now, false, new Set()),
    ).toBeNull();
    expect(receiptProblem(p, 'u1', now, false, new Set([payload.key]))).toMatch(/twice/);
  });
});
