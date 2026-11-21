import type { NotificationCategory, NotificationPriority } from '../../domain.js';

import type { ExternalChannel } from '../templates/index.js';

/**
 * Delivery policy (pure). In-app is always on and is not decided here.
 *  - SECURITY notifications and CRITICAL priority are MANDATORY: user opt-outs are ignored.
 *  - PROMO is opt-in: off unless the user enabled the channel.
 *  - Every other category is opt-out: on unless the user disabled the channel.
 *  - SMS (cost, DLT) only for HIGH / CRITICAL, whatever the preference.
 */
export const isMandatory = (category: NotificationCategory, priority: NotificationPriority) =>
  category === 'SECURITY' || priority === 'CRITICAL';

export const defaultEnabled = (category: NotificationCategory): boolean => category !== 'PROMO';

/** Categories a user can change (SECURITY is fixed on). */
export const CONFIGURABLE_CATEGORIES: readonly NotificationCategory[] = [
  'ORDER',
  'PAYMENT',
  'REFUND',
  'INVENTORY',
  'ACCOUNT',
  'PROMO',
  'SYSTEM',
  'CONTENT',
];

export const allowedChannels = (
  requested: readonly ExternalChannel[],
  category: NotificationCategory,
  priority: NotificationPriority,
  prefs: ReadonlyMap<ExternalChannel, boolean>,
): ExternalChannel[] => {
  const mandatory = isMandatory(category, priority);
  return requested.filter((channel) => {
    if (channel === 'SMS' && priority !== 'HIGH' && priority !== 'CRITICAL') return false;
    if (mandatory) return true;
    return prefs.get(channel) ?? defaultEnabled(category);
  });
};
