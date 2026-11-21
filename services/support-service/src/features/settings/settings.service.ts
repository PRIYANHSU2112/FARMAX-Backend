import { NotFoundError } from '@farmx/common/errors';
import { supportKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import { Snapshot } from '../../adapters/cache-gen.js';
import type { Actor } from '../audit/index.js';
import type { BusinessCalendar } from '../topics/index.js';
import {
  type CalendarInput,
  type CalendarView,
  DEFAULT_SETTINGS,
  SETTING_KEYS,
  type SettingKey,
  type SupportSettings,
} from './settings.types.js';

interface SettingsSnapshot {
  settings: SupportSettings;
  calendars: CalendarView[];
}

type Deps = Pick<
  Cradle,
  'settingsRepository' | 'auditService' | 'runInTransaction' | 'cache' | 'cacheGen'
>;

export class SettingsService {
  private readonly snapshot: Snapshot<SettingsSnapshot>;
  private calendarCache: { source: CalendarView[]; map: Map<string, BusinessCalendar> } | undefined;

  constructor(private readonly deps: Deps) {
    this.snapshot = new Snapshot({
      gen: () => deps.cacheGen.config(),
      load: (gen) =>
        deps.cache.getOrSet(`${supportKeys.config(gen)}:settings`, 600, () => this.load()),
    });
  }

  async current(): Promise<SupportSettings> {
    return (await this.snapshot.get()).settings;
  }

  /** The business calendar for SLA maths (null = unknown → 24×7). */
  async calendar(id: string | null): Promise<BusinessCalendar | null> {
    if (id === null) return null;
    const { calendars } = await this.snapshot.get();
    if (this.calendarCache?.source !== calendars) {
      this.calendarCache = {
        source: calendars,
        map: new Map(
          calendars
            .filter((c) => c.isActive)
            .map((c) => [
              c.id,
              { timezone: c.timezone, weekly: c.weeklyHours, holidays: new Set(c.holidays.map((h) => h.date)) },
            ]),
        ),
      };
    }
    return this.calendarCache.map.get(id) ?? null;
  }

  // ── Admin ──

  async listSettings() {
    const rows = await this.deps.settingsRepository.allSettings();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return SETTING_KEYS.map((key) => ({
      key,
      value: byKey.get(key)?.value ?? DEFAULT_SETTINGS[key],
      updatedByUserId: byKey.get(key)?.updatedByUserId ?? null,
      updatedAt: byKey.get(key)?.updatedAt ?? null,
    }));
  }

  async updateSetting(actor: Actor, key: SettingKey, value: object, reason: string) {
    await this.deps.runInTransaction(async (tx) => {
      const before = await this.deps.settingsRepository.findSettingForUpdate(tx, key);
      await this.deps.settingsRepository.upsertSetting(tx, key, value, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'setting.update',
        targetType: 'setting',
        targetId: key,
        before: (before as object | undefined) ?? null,
        after: value,
        reason,
      });
    });
    await this.changed();
    return { key, value };
  }

  listCalendars(): Promise<CalendarView[]> {
    return this.deps.settingsRepository.calendars();
  }

  async createCalendar(actor: Actor, input: CalendarInput): Promise<CalendarView> {
    const id = await this.deps.runInTransaction(async (tx) => {
      const created = await this.deps.settingsRepository.createCalendar(tx, input);
      await this.deps.auditService.record(tx, actor, {
        action: 'calendar.create',
        targetType: 'calendar',
        targetId: created,
        after: { name: input.name, timezone: input.timezone, weeklyHours: input.weeklyHours },
        reason: input.reason ?? null,
      });
      return created;
    });
    await this.changed();
    return this.mustFindCalendar(id);
  }

  async updateCalendar(actor: Actor, id: string, input: Partial<CalendarInput>): Promise<CalendarView> {
    await this.deps.runInTransaction(async (tx) => {
      if (!(await this.deps.settingsRepository.updateCalendar(tx, id, input)))
        throw new NotFoundError('Calendar');
      await this.deps.auditService.record(tx, actor, {
        action: 'calendar.update',
        targetType: 'calendar',
        targetId: id,
        after: { ...input, reason: undefined },
        reason: input.reason ?? null,
      });
    });
    await this.changed();
    return this.mustFindCalendar(id);
  }

  async addHoliday(actor: Actor, calendarId: string, date: string, name: string): Promise<CalendarView> {
    if (!(await this.deps.settingsRepository.calendarExists(calendarId))) throw new NotFoundError('Calendar');
    await this.deps.runInTransaction(async (tx) => {
      const id = await this.deps.settingsRepository.addHoliday(tx, calendarId, date, name);
      await this.deps.auditService.record(tx, actor, {
        action: 'holiday.create',
        targetType: 'holiday',
        targetId: id,
        after: { calendarId, date, name },
      });
    });
    await this.changed();
    return this.mustFindCalendar(calendarId);
  }

  async deleteHoliday(actor: Actor, calendarId: string, holidayId: string, reason: string): Promise<void> {
    await this.deps.runInTransaction(async (tx) => {
      if (!(await this.deps.settingsRepository.deleteHoliday(tx, calendarId, holidayId)))
        throw new NotFoundError('Holiday');
      await this.deps.auditService.record(tx, actor, {
        action: 'holiday.delete',
        targetType: 'holiday',
        targetId: holidayId,
        before: { calendarId },
        reason,
      });
    });
    await this.changed();
  }

  private async mustFindCalendar(id: string): Promise<CalendarView> {
    const found = (await this.deps.settingsRepository.calendars()).find((c) => c.id === id);
    if (found === undefined) throw new NotFoundError('Calendar');
    return found;
  }

  private async changed(): Promise<void> {
    await this.deps.cacheGen.bumpConfig();
    this.snapshot.reset();
  }

  private async load(): Promise<SettingsSnapshot> {
    const [rows, calendars] = await Promise.all([
      this.deps.settingsRepository.allSettings(),
      this.deps.settingsRepository.calendars(),
    ]);
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const settings = Object.fromEntries(
      SETTING_KEYS.map((k) => [k, { ...DEFAULT_SETTINGS[k], ...((byKey.get(k) as object | undefined) ?? {}) }]),
    ) as unknown as SupportSettings;
    return { settings, calendars };
  }
}
