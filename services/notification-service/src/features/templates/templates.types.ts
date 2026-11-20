import type { NotificationChannel } from '../../domain.js';

export type Channel = NotificationChannel;
/** Channels with a provider behind them (in-app is the inbox row itself). */
export type ExternalChannel = Exclude<Channel, 'IN_APP'>;
export const EXTERNAL_CHANNELS: readonly ExternalChannel[] = ['PUSH', 'EMAIL', 'SMS'];

export type VariableType = 'string' | 'number' | 'money' | 'date';

/** One declared template variable (`notification_templates.variables`). */
export interface VariableDef {
  name: string;
  type: VariableType;
  /** Default true. */
  required?: boolean;
  /** Strings only. Default 200. */
  maxLength?: number;
}

/**
 * Raw values from a rule or an admin send. money = rupees (number or decimal string),
 * date = ISO-8601 string. Missing optional values render as ''.
 */
export type TemplateVars = Readonly<Record<string, string | number | null | undefined>>;

export interface TemplateRow {
  key: string;
  channel: Channel;
  locale: string;
  version: number;
  title: string | null;
  body: string;
  htmlBody: string | null;
  variables: VariableDef[];
}

/** Rendered once per notification and stored in `notifications.content`. */
export interface ChannelContent {
  PUSH?: { title: string; body: string };
  EMAIL?: { subject: string; text: string; html: string };
  SMS?: { text: string };
}

export interface Rendered {
  version: number;
  /** In-app title / body. */
  title: string;
  body: string;
  content: ChannelContent;
  /** Requested channels that have a template (others are dropped and logged). */
  channels: ExternalChannel[];
}

/** A stored template version (admin view). */
export interface TemplateRecord extends TemplateRow {
  id: string;
  description: string | null;
  isActive: boolean;
  createdBy: string | null;
  createdAt: Date;
}

/** Content of a new template version (key / channel / locale come from the family). */
export interface TemplateInput {
  title?: string | null;
  body: string;
  htmlBody?: string | null;
  description?: string | null;
}
