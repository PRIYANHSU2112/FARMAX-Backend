import Joi from 'joi';

/** Contact card on Help & Support, FAQ "Still have questions?" and the privacy page. */
export interface ContactsSetting {
  companyName: string;
  supportPhone: string;
  supportEmail: string;
  whatsapp: string;
  hoursText: string;
  privacyEmail: string;
  address: string;
}

export interface LimitsSetting {
  /** Open (not resolved / closed) tickets a requester may have at once. */
  maxOpenTicketsPerUser: number;
  /** RESOLVED tickets with no feedback close after this many hours. */
  autoCloseHours: number;
  maxAttachmentsPerMessage: number;
}

export interface ChatSetting {
  /** Live chat on/off (the Chat tile and WebSocket connect tokens). */
  enabled: boolean;
  /** Calendar whose hours decide "online" in the app (agents can still answer outside). */
  calendarId: string | null;
}

export interface SupportSettings {
  contacts: ContactsSetting;
  limits: LimitsSetting;
  chat: ChatSetting;
}

export type SettingKey = keyof SupportSettings;
export const SETTING_KEYS = ['contacts', 'limits', 'chat'] as const satisfies readonly SettingKey[];

export const DEFAULT_SETTINGS: SupportSettings = {
  contacts: {
    companyName: 'FarmX',
    supportPhone: '+910000000000',
    supportEmail: 'support@farmx.in',
    whatsapp: '+910000000000',
    hoursText: 'Our support team is here 9 AM – 9 PM, every day',
    privacyEmail: 'privacy@farmx.in',
    address: '',
  },
  limits: { maxOpenTicketsPerUser: 10, autoCloseHours: 72, maxAttachmentsPerMessage: 5 },
  chat: { enabled: true, calendarId: null },
};

const PHONE = Joi.string()
  .pattern(/^\+[1-9]\d{7,14}$/)
  .messages({ 'string.pattern.base': 'must be E.164, e.g. +919876543210' });

export const SETTING_SCHEMAS: Record<SettingKey, Joi.ObjectSchema> = {
  contacts: Joi.object<ContactsSetting>({
    companyName: Joi.string().trim().min(1).max(120).required(),
    supportPhone: PHONE.required(),
    supportEmail: Joi.string().email().required(),
    whatsapp: PHONE.required(),
    hoursText: Joi.string().trim().max(120).required(),
    privacyEmail: Joi.string().email().required(),
    address: Joi.string().trim().allow('').max(300).required(),
  }),
  limits: Joi.object<LimitsSetting>({
    maxOpenTicketsPerUser: Joi.number().integer().min(1).max(100).required(),
    autoCloseHours: Joi.number().integer().min(1).max(720).required(),
    maxAttachmentsPerMessage: Joi.number().integer().min(0).max(10).required(),
  }),
  chat: Joi.object<ChatSetting>({
    enabled: Joi.boolean().required(),
    calendarId: Joi.string().guid().allow(null).required(),
  }),
};

export interface WeeklyWindow {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export interface CalendarView {
  id: string;
  name: string;
  timezone: string;
  weeklyHours: WeeklyWindow[];
  isActive: boolean;
  holidays: { id: string; date: string; name: string }[];
  updatedAt: Date;
}

export interface CalendarInput {
  name: string;
  timezone: string;
  weeklyHours: WeeklyWindow[];
  isActive?: boolean;
  reason?: string;
}
