import type { ModerationAction, ReviewStatus } from './reviews.types.js';

/**
 * Review state machine (admin actions). Author edits and auto-moderation use the rules in
 * reviews.rules.ts; deletion is a soft delete from any status.
 *
 *   create → PUBLISHED (clean) | PENDING (flagged)
 *   PENDING   → PUBLISHED (approve) | REJECTED (reject) | HIDDEN (hide)
 *   PUBLISHED → HIDDEN (hide, or auto after N reports) | REJECTED (reject)
 *   HIDDEN    → PUBLISHED (restore) | REJECTED (reject)
 *   REJECTED  → PUBLISHED (restore) | PENDING (author edits)
 */
interface Transition {
  from: readonly ReviewStatus[];
  to: ReviewStatus;
  /** A reason (10–500 chars) is mandatory and shown to the author. */
  needsReason: boolean;
  /** Open reports are closed with this outcome. */
  closesReportsAs: 'UPHELD' | 'DISMISSED';
}

export const REVIEW_TRANSITIONS: Readonly<Record<ModerationAction, Transition>> = {
  approve: { from: ['PENDING'], to: 'PUBLISHED', needsReason: false, closesReportsAs: 'DISMISSED' },
  reject: {
    from: ['PENDING', 'PUBLISHED', 'HIDDEN'],
    to: 'REJECTED',
    needsReason: true,
    closesReportsAs: 'UPHELD',
  },
  hide: {
    from: ['PENDING', 'PUBLISHED'],
    to: 'HIDDEN',
    needsReason: true,
    closesReportsAs: 'UPHELD',
  },
  restore: {
    from: ['HIDDEN', 'REJECTED'],
    to: 'PUBLISHED',
    needsReason: false,
    closesReportsAs: 'DISMISSED',
  },
};

/** Target status, or null when `action` is not allowed from `current`. */
export const nextReviewStatus = (
  current: ReviewStatus,
  action: ModerationAction,
): ReviewStatus | null => {
  const t = REVIEW_TRANSITIONS[action];
  return t.from.includes(current) ? t.to : null;
};

/** The author may edit while the review is not taken down (HIDDEN waits for an admin). */
export const isAuthorEditable = (status: ReviewStatus): boolean => status !== 'HIDDEN';
