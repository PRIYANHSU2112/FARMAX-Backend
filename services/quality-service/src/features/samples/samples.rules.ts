/** Pure sample rules (D-60, W16.01–W16.04): the status machine, dashboard buckets, lab steps. */

export type SampleStatus =
  | 'PENDING'
  | 'COLLECTED'
  | 'SENT'
  | 'ACKNOWLEDGED'
  | 'TESTING'
  | 'RESULTS_RECEIVED'
  | 'PASSED'
  | 'FAILED'
  | 'CANCELLED';

export type SampleAction = 'collect' | 'send' | 'lab-status' | 'flag' | 'cancel';

const ORDER: readonly SampleStatus[] = [
  'PENDING',
  'COLLECTED',
  'SENT',
  'ACKNOWLEDGED',
  'TESTING',
  'RESULTS_RECEIVED',
];
const TERMINAL = new Set<SampleStatus>(['PASSED', 'FAILED', 'CANCELLED']);

export const isTerminal = (s: SampleStatus): boolean => TERMINAL.has(s);

/** Statuses an action may start from. */
export const FROM: Record<Exclude<SampleAction, 'lab-status'>, readonly SampleStatus[]> = {
  collect: ['PENDING'],
  send: ['COLLECTED'],
  flag: ['PENDING', 'COLLECTED', 'SENT', 'ACKNOWLEDGED', 'TESTING', 'RESULTS_RECEIVED'],
  cancel: ['PENDING', 'COLLECTED', 'SENT', 'ACKNOWLEDGED', 'TESTING'],
};

/** Lab progress moves forward only (SENT → ACKNOWLEDGED → TESTING → RESULTS_RECEIVED). */
export function labStepAllowed(from: SampleStatus, to: SampleStatus): boolean {
  if (!['ACKNOWLEDGED', 'TESTING', 'RESULTS_RECEIVED'].includes(to)) return false;
  const f = ORDER.indexOf(from);
  return f >= ORDER.indexOf('SENT') && ORDER.indexOf(to) > f;
}

export type Bucket = 'pending' | 'testing' | 'passed' | 'failed' | 'cancelled';

/** W16.01 cards: Pending samples · Testing in progress · Passed · Failed. */
export function bucketOf(s: SampleStatus): Bucket {
  switch (s) {
    case 'PENDING':
    case 'COLLECTED':
      return 'pending';
    case 'PASSED':
      return 'passed';
    case 'FAILED':
      return 'failed';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return 'testing';
  }
}

export const BUCKET_STATUSES: Record<Bucket, SampleStatus[]> = {
  pending: ['PENDING', 'COLLECTED'],
  testing: ['SENT', 'ACKNOWLEDGED', 'TESTING', 'RESULTS_RECEIVED'],
  passed: ['PASSED'],
  failed: ['FAILED'],
  cancelled: ['CANCELLED'],
};

export type StepState = 'COMPLETED' | 'CURRENT' | 'PENDING';

/**
 * W16.04 Laboratory Test Status: 01 Sample collected · 02 Laboratory acknowledged ·
 * 03 Tests in progress · 04 Results received.
 */
export function labSteps(
  s: SampleStatus,
): { no: string; key: string; label: string; state: StepState }[] {
  const reached = (target: SampleStatus) =>
    s === 'PASSED' || s === 'FAILED' || ORDER.indexOf(s) >= ORDER.indexOf(target);
  const steps: [string, string, SampleStatus][] = [
    ['COLLECTED', 'Sample collected', 'COLLECTED'],
    ['ACKNOWLEDGED', 'Laboratory acknowledged', 'ACKNOWLEDGED'],
    ['TESTING', 'Tests in progress', 'TESTING'],
    ['RESULTS_RECEIVED', 'Results received', 'RESULTS_RECEIVED'],
  ];
  let currentGiven = false;
  return steps.map(([key, label, target], i) => {
    let state: StepState = 'PENDING';
    if (reached(target)) state = 'COMPLETED';
    else if (!currentGiven && s !== 'CANCELLED') {
      state = 'CURRENT';
      currentGiven = true;
    }
    return { no: String(i + 1).padStart(2, '0'), key, label, state };
  });
}

/** Expected result date = sent + lab turnaround days. */
export const expectedResultAt = (sentAt: Date, tatDays: number): Date =>
  new Date(sentAt.getTime() + tatDays * 24 * 60 * 60 * 1000);
