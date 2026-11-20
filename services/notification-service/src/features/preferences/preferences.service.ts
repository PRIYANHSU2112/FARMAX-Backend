import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { NotificationCategory, NotificationPriority } from '../../domain.js';
import type { ExternalChannel } from '../templates/index.js';
import {
  CONFIGURABLE_CATEGORIES,
  allowedChannels,
  defaultEnabled,
  isMandatory,
} from './preferences.policy.js';

/** One row of the preferences screen. In-app is always on and not listed. */
export interface PreferenceView {
  category: NotificationCategory;
  /** true = always delivered (SECURITY); the toggles are read-only. */
  mandatory: boolean;
  push: boolean;
  email: boolean;
  sms: boolean;
}

export interface PreferenceChange {
  category: NotificationCategory;
  channel: ExternalChannel;
  enabled: boolean;
}

type Deps = Pick<Cradle, 'preferencesRepository'>;

export class PreferencesService {
  constructor(private readonly deps: Deps) {}

  /**
   * External channels each user gets for one notification. One query for the whole page; none
   * when the notification is mandatory or asks for no external channel.
   */
  async channelsFor(
    userIds: readonly string[],
    category: NotificationCategory,
    priority: NotificationPriority,
    requested: readonly ExternalChannel[],
    tx?: Tx,
  ): Promise<Map<string, ExternalChannel[]>> {
    const prefs = new Map<string, Map<ExternalChannel, boolean>>();
    if (requested.length > 0 && !isMandatory(category, priority)) {
      for (const row of await this.deps.preferencesRepository.findForUsers(userIds, category, tx)) {
        const own = prefs.get(row.userId) ?? new Map<ExternalChannel, boolean>();
        own.set(row.channel, row.enabled);
        prefs.set(row.userId, own);
      }
    }
    const none: ReadonlyMap<ExternalChannel, boolean> = new Map<ExternalChannel, boolean>();
    return new Map(
      userIds.map((userId) => [
        userId,
        allowedChannels(requested, category, priority, prefs.get(userId) ?? none),
      ]),
    );
  }

  /** The full matrix with defaults filled in (one query). */
  async getForUser(userId: string): Promise<PreferenceView[]> {
    const rows = await this.deps.preferencesRepository.findForUser(userId);
    const choice = new Map(rows.map((r) => [`${r.category}|${r.channel}`, r.enabled]));
    const on = (category: NotificationCategory, channel: ExternalChannel) =>
      choice.get(`${category}|${channel}`) ?? defaultEnabled(category);
    return [
      ...CONFIGURABLE_CATEGORIES.map((category) => ({
        category,
        mandatory: false,
        push: on(category, 'PUSH'),
        email: on(category, 'EMAIL'),
        sms: on(category, 'SMS'),
      })),
      { category: 'SECURITY', mandatory: true, push: true, email: true, sms: true },
    ];
  }

  async update(userId: string, changes: readonly PreferenceChange[]): Promise<PreferenceView[]> {
    await this.deps.preferencesRepository.upsert(userId, changes);
    return this.getForUser(userId);
  }
}
