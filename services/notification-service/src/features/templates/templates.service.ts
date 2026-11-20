import type { Cradle } from '@fastify/awilix';

import type { NotificationChannel as Channel } from '../../domain.js';
import {
  clip,
  escapeHtml,
  fill,
  formatVariables,
  singleLine,
  textToHtml,
} from './templates.renderer.js';
import type {
  ChannelContent,
  ExternalChannel,
  Rendered,
  TemplateRow,
  TemplateVars,
  VariableDef,
} from './templates.types.js';

/** Active templates are cached per process for a minute (edits invalidate this replica now). */
const CACHE_TTL_MS = 60_000;

/** Column / provider limits. */
const LIMITS = { title: 200, body: 1000, pushTitle: 100, pushBody: 240, subject: 200, sms: 480 };

/** One channel rendered from one template version (also the admin preview). */
export interface RenderedChannel {
  channel: Channel;
  /** In-app / push title or email subject; null for SMS. */
  title: string | null;
  text: string;
  /** Email only. */
  html: string | null;
}

type Deps = Pick<Cradle, 'templatesRepository' | 'logger'>;

export class TemplatesService {
  private readonly cache = new Map<string, { at: number; rows: TemplateRow[] }>();

  constructor(private readonly deps: Deps) {}

  /**
   * Renders the in-app text and every requested channel ONCE (stored on the notification; workers
   * never read templates). PUSH falls back to the IN_APP template; a channel without a template is
   * dropped. Throws 422 ValidationError for bad variables, and an Error when the key has no active
   * IN_APP template (configuration bug → the event is retried, then dead-lettered).
   */
  async render(
    key: string,
    channels: readonly ExternalChannel[],
    vars: TemplateVars,
    locale = 'en',
  ): Promise<Rendered> {
    const rows = await this.active(key, locale);
    const byChannel = new Map(rows.map((row) => [row.channel, row]));
    const inApp = byChannel.get('IN_APP');
    if (inApp === undefined) throw new Error(`no active IN_APP template "${key}" (${locale})`);
    const values = formatVariables(mergeDefs(rows), vars);

    const main = renderChannel('IN_APP', inApp, values);
    const content: ChannelContent = {};
    const rendered: ExternalChannel[] = [];
    for (const channel of channels) {
      const row = byChannel.get(channel) ?? (channel === 'PUSH' ? inApp : undefined);
      if (row === undefined) {
        this.deps.logger.warn({ key, channel, locale }, 'no active template for channel; skipped');
        continue;
      }
      rendered.push(channel);
      const r = renderChannel(channel, row, values, main.title ?? '');
      if (channel === 'PUSH') content.PUSH = { title: r.title ?? '', body: r.text };
      else if (channel === 'EMAIL')
        content.EMAIL = { subject: r.title ?? '', text: r.text, html: r.html ?? '' };
      else content.SMS = { text: r.text };
    }
    return {
      version: inApp.version,
      title: main.title ?? '',
      body: main.text,
      content,
      channels: rendered,
    };
  }

  /** Admin preview of ONE template version (active or not) with sample values. */
  preview(row: TemplateRow, vars: TemplateVars): RenderedChannel {
    return renderChannel(row.channel, row, formatVariables(row.variables, vars));
  }

  /** Drops the cached versions of a key (after a template edit / activation). */
  invalidate(key: string): void {
    for (const cacheKey of this.cache.keys())
      if (cacheKey.startsWith(`${key}|`)) this.cache.delete(cacheKey);
  }

  private async active(key: string, locale: string): Promise<TemplateRow[]> {
    const cacheKey = `${key}|${locale}`;
    const hit = this.cache.get(cacheKey);
    if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
    const rows = await this.deps.templatesRepository.findActive(key, locale);
    this.cache.set(cacheKey, { at: Date.now(), rows });
    return rows;
  }
}

/** One channel's text with that channel's limits and escaping. */
const renderChannel = (
  channel: Channel,
  row: TemplateRow,
  values: Readonly<Record<string, string>>,
  fallbackTitle = '',
): RenderedChannel => {
  const text = fill(row.body, values).trim();
  const title = singleLine(fill(row.title ?? '', values));
  switch (channel) {
    case 'IN_APP':
      return {
        channel,
        title: clip(title, LIMITS.title),
        text: clip(text, LIMITS.body),
        html: null,
      };
    case 'PUSH':
      return {
        channel,
        title: clip(title, LIMITS.pushTitle),
        text: clip(singleLine(text), LIMITS.pushBody),
        html: null,
      };
    case 'EMAIL':
      return {
        channel,
        title: clip(title === '' ? fallbackTitle : title, LIMITS.subject),
        text,
        html: row.htmlBody === null ? textToHtml(text) : fill(row.htmlBody, values, escapeHtml),
      };
    case 'SMS':
      return { channel, title: null, text: clip(singleLine(text), LIMITS.sms), html: null };
  }
};

/** One definition per name across channels; required anywhere → required. */
const mergeDefs = (rows: readonly TemplateRow[]): VariableDef[] => {
  const merged = new Map<string, VariableDef>();
  for (const row of rows) {
    for (const def of row.variables) {
      const seen = merged.get(def.name);
      if (seen === undefined) merged.set(def.name, { ...def });
      else if (def.required !== false) seen.required = true;
    }
  }
  return [...merged.values()];
};
