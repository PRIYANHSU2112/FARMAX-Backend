import type { ProductStatus } from './products.types.js';

/** Lifecycle actions (each is one admin route). */
export type StatusAction =
  'submit' | 'approve' | 'reject' | 'suspend' | 'reinstate' | 'discontinue';

interface Transition {
  from: readonly ProductStatus[];
  to: ProductStatus;
  /** `catalogue.manage` prepares; `catalogue.publish` (sensitive) decides what is sellable. */
  permission: 'catalogue.manage' | 'catalogue.publish';
  /** Run the regulatory matrix before entering `to`. */
  checksCompliance: boolean;
}

export const TRANSITIONS: Readonly<Record<StatusAction, Transition>> = {
  submit: {
    from: ['DRAFT'],
    to: 'PENDING_REVIEW',
    permission: 'catalogue.manage',
    checksCompliance: true,
  },
  approve: {
    from: ['PENDING_REVIEW'],
    to: 'PUBLISHED',
    permission: 'catalogue.publish',
    checksCompliance: true,
  },
  reject: {
    from: ['PENDING_REVIEW'],
    to: 'DRAFT',
    permission: 'catalogue.publish',
    checksCompliance: false,
  },
  suspend: {
    from: ['PUBLISHED'],
    to: 'SUSPENDED',
    permission: 'catalogue.publish',
    checksCompliance: false,
  },
  reinstate: {
    from: ['SUSPENDED'],
    to: 'PUBLISHED',
    permission: 'catalogue.publish',
    checksCompliance: true,
  },
  discontinue: {
    from: ['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'SUSPENDED'],
    to: 'DISCONTINUED',
    permission: 'catalogue.publish',
    checksCompliance: false,
  },
};

/** Target status, or null when the action is not allowed from `current`. */
export const nextStatus = (current: ProductStatus, action: StatusAction): ProductStatus | null => {
  const t = TRANSITIONS[action];
  return t.from.includes(current) ? t.to : null;
};

/** Editing content is allowed until the product is discontinued. */
export const isEditable = (status: ProductStatus): boolean => status !== 'DISCONTINUED';

/** Soft delete only for never-sold drafts or retired products. */
export const isDeletable = (status: ProductStatus): boolean =>
  status === 'DRAFT' || status === 'DISCONTINUED';
