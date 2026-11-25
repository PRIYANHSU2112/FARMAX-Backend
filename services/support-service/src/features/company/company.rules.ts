import { ConflictError, ForbiddenError, ValidationError } from '@farmx/common/errors';

import type { ApplicationRow, ReviewInput } from './company.types.js';

/**
 * Application state machine: SUBMITTED → APPROVED | REJECTED (both final). A rejection needs a
 * reason the applicant can read; nobody reviews their own application (segregation of duties).
 * Throws on a refused review; returns nothing when the review may proceed.
 */
export function assertReviewable(
  app: Pick<ApplicationRow, 'status' | 'applicantUserId'>,
  reviewerId: string,
  input: ReviewInput,
): void {
  if (app.status !== 'SUBMITTED')
    throw new ConflictError(`Application is already ${app.status.toLowerCase()}`);
  if (app.applicantUserId === reviewerId)
    throw new ForbiddenError('You cannot review your own application');
  if (input.status === 'REJECTED' && (input.reviewNotes ?? '').trim().length < 5)
    throw new ValidationError([
      { path: 'body.reviewNotes', message: 'A rejection needs a reason (at least 5 characters)' },
    ]);
}
