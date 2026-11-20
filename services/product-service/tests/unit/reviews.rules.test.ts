import { describe, expect, it } from 'vitest';

import {
  averageOf,
  compileBannedWords,
  contributionOf,
  distributionOf,
  initialStatus,
  isAllowedImageUrl,
  isZeroDelta,
  maskName,
  moderationFlags,
  sanitizeText,
  statusAfterEdit,
  summaryDelta,
} from '../../src/features/reviews/reviews.rules.js';
import { isAuthorEditable, nextReviewStatus } from '../../src/features/reviews/reviews.status.js';

const banned = compileBannedWords(['whatsapp', 'call me']);
const flagsOf = (body: string | null, title: string | null = null, hasImages = false) =>
  moderationFlags({ title, body, hasImages }, banned);

describe('sanitizeText', () => {
  it('strips HTML, control and zero-width characters and collapses blanks', () => {
    expect(sanitizeText('  <b>Good</b>​   product\u0007 ')).toBe('Good product');
  });
  it('keeps at most one blank line', () => {
    expect(sanitizeText('a\r\n\r\n\r\n\r\nb')).toBe('a\n\nb');
  });
  it('empty or whitespace → null', () => {
    expect(sanitizeText('   ')).toBeNull();
    expect(sanitizeText(undefined)).toBeNull();
    expect(sanitizeText('<p></p>')).toBeNull();
  });
});

describe('moderationFlags', () => {
  it('clean text and rating-only reviews publish', () => {
    expect(flagsOf('Worked well for CRD in my broiler flock')).toEqual([]);
    expect(flagsOf(null)).toEqual([]);
    expect(initialStatus([])).toBe('PUBLISHED');
  });
  it('flags images, links, emails and phone numbers', () => {
    expect(flagsOf(null, null, true)).toEqual(['IMAGES']);
    expect(flagsOf('cheaper at www.example.com')).toContain('LINK');
    expect(flagsOf('see shop.in for more')).toContain('LINK');
    expect(flagsOf('mail me at a.b@x.co')).toContain('EMAIL');
    expect(flagsOf('call 98765 43210 now')).toContain('PHONE');
    expect(flagsOf('+91-9876543210')).toContain('PHONE');
  });
  it('does not treat dosages or bird counts as phone numbers', () => {
    expect(flagsOf('1 ml per litre for 5 days, 5000 birds, 2 bottles')).toEqual([]);
  });
  it('flags banned words as whole words only (case-insensitive)', () => {
    expect(flagsOf('Ping me on WhatsApp')).toContain('BANNED_WORD');
    expect(flagsOf('please Call Me')).toContain('BANNED_WORD');
    expect(flagsOf('recall messages')).not.toContain('BANNED_WORD');
  });
  it('flags shouting and repeated characters', () => {
    expect(flagsOf('THIS PRODUCT IS TOTALLY USELESS DO NOT BUY')).toContain('SHOUTING');
    expect(flagsOf('goooooooood')).toContain('REPEATED');
    expect(initialStatus(['LINK'])).toBe('PENDING');
  });
  it('no banned list → no banned-word flag', () => {
    expect(compileBannedWords(['', ' '])).toBeNull();
  });
});

describe('statusAfterEdit', () => {
  it('rejected reviews always go back to moderation', () => {
    expect(statusAfterEdit('REJECTED', [])).toBe('PENDING');
  });
  it('otherwise the new content decides', () => {
    expect(statusAfterEdit('PUBLISHED', [])).toBe('PUBLISHED');
    expect(statusAfterEdit('PUBLISHED', ['PHONE'])).toBe('PENDING');
    expect(statusAfterEdit('PENDING', [])).toBe('PUBLISHED');
  });
});

describe('maskName', () => {
  it('first name + last initial', () => {
    expect(maskName('ramesh kumar REDDY')).toBe('Ramesh R.');
    expect(maskName('Lakshmi')).toBe('Lakshmi');
  });
  it('falls back when nothing usable', () => {
    expect(maskName(null)).toBe('FarmX Customer');
    expect(maskName('  123 ')).toBe('FarmX Customer');
  });
});

describe('isAllowedImageUrl', () => {
  it('requires the media-service base when configured', () => {
    expect(isAllowedImageUrl('https://cdn.farmx.in/r/a.jpg', 'https://cdn.farmx.in')).toBe(true);
    expect(isAllowedImageUrl('https://cdn.farmx.in.evil.com/a.jpg', 'https://cdn.farmx.in')).toBe(
      false,
    );
  });
  it('otherwise https only', () => {
    expect(isAllowedImageUrl('http://x/a.jpg', undefined)).toBe(false);
    expect(isAllowedImageUrl('https://x/a.jpg', undefined)).toBe(true);
  });
});

describe('rating summary delta', () => {
  const pub = (rating: number, extra: { title?: string | null; hasImages?: boolean } = {}) =>
    contributionOf({
      status: 'PUBLISHED',
      rating,
      title: extra.title ?? null,
      body: null,
      hasImages: extra.hasImages ?? false,
    });

  it('only PUBLISHED, non-deleted reviews contribute', () => {
    expect(
      contributionOf({ status: 'PENDING', rating: 5, title: null, body: null, hasImages: false }),
    ).toBeNull();
    expect(
      contributionOf({
        status: 'PUBLISHED',
        deleted: true,
        rating: 5,
        title: null,
        body: null,
        hasImages: false,
      }),
    ).toBeNull();
  });
  it('new published review adds one rating', () => {
    const d = summaryDelta(null, pub(4, { title: 'ok', hasImages: true }));
    expect(d).toEqual({ count: 1, sum: 4, stars: [0, 0, 0, 1, 0], text: 1, image: 1 });
  });
  it('edit 3★ → 5★ moves one star bucket and adds 2 to the sum', () => {
    const d = summaryDelta(pub(3), pub(5));
    expect(d).toEqual({ count: 0, sum: 2, stars: [0, 0, -1, 0, 1], text: 0, image: 0 });
  });
  it('hide / delete removes it; no change → zero delta', () => {
    expect(summaryDelta(pub(2), null)).toEqual({
      count: -1,
      sum: -2,
      stars: [0, -1, 0, 0, 0],
      text: 0,
      image: 0,
    });
    expect(isZeroDelta(summaryDelta(null, null))).toBe(true);
    expect(isZeroDelta(summaryDelta(pub(4), pub(4)))).toBe(true);
  });
  it('average and distribution', () => {
    expect(averageOf(557, 128)).toBe('4.35');
    expect(averageOf(0, 0)).toBeNull();
    expect(distributionOf([6, 4, 10, 28, 80], 128)[0]).toEqual({
      stars: 5,
      count: 80,
      percent: 63,
    });
    expect(distributionOf([0, 0, 0, 0, 0], 0).every((r) => r.percent === 0)).toBe(true);
  });
});

describe('review state machine', () => {
  it('allowed transitions', () => {
    expect(nextReviewStatus('PENDING', 'approve')).toBe('PUBLISHED');
    expect(nextReviewStatus('PUBLISHED', 'hide')).toBe('HIDDEN');
    expect(nextReviewStatus('HIDDEN', 'restore')).toBe('PUBLISHED');
    expect(nextReviewStatus('REJECTED', 'restore')).toBe('PUBLISHED');
    expect(nextReviewStatus('HIDDEN', 'reject')).toBe('REJECTED');
  });
  it('denied transitions', () => {
    expect(nextReviewStatus('PUBLISHED', 'approve')).toBeNull();
    expect(nextReviewStatus('REJECTED', 'hide')).toBeNull();
    expect(nextReviewStatus('PUBLISHED', 'restore')).toBeNull();
  });
  it('authors cannot edit a hidden review', () => {
    expect(isAuthorEditable('HIDDEN')).toBe(false);
    expect(isAuthorEditable('REJECTED')).toBe(true);
  });
});
