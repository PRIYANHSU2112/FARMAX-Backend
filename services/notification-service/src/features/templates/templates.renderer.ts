import { ValidationError } from '@farmx/common/errors';

import type { TemplateVars, VariableDef } from './templates.types.js';

/**
 * Pure `{{name}}` renderer: no logic, helpers, partials or nested lookups, single pass (a value
 * that contains `{{x}}` is never expanded again). Values are validated against the template's
 * declared variables, then formatted (₹, en-IN dates in IST) and sanitised.
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,39})\s*\}\}/g;
// eslint-disable-next-line no-control-regex -- strips C0/C1 control characters from values
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const DEFAULT_MAX_LENGTH = 200;

const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const integer = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Kolkata',
});

/** Placeholder names used in a template text (for save-time checks). */
export const placeholdersOf = (text: string): string[] =>
  [...text.matchAll(PLACEHOLDER)].map((m) => m[1] ?? '');

/**
 * Validates `vars` against `defs` and returns display strings. Unknown names, missing required
 * values and wrong types → 422 ValidationError (issues per variable).
 */
export const formatVariables = (
  defs: readonly VariableDef[],
  vars: TemplateVars,
): Record<string, string> => {
  const issues: { path: string; message: string }[] = [];
  const byName = new Map(defs.map((d) => [d.name, d]));
  for (const name of Object.keys(vars))
    if (!byName.has(name)) issues.push({ path: name, message: 'is not a template variable' });
  const out: Record<string, string> = {};
  for (const def of defs) {
    const raw = vars[def.name];
    if (raw === undefined || raw === null || raw === '') {
      if (def.required !== false) issues.push({ path: def.name, message: 'is required' });
      out[def.name] = '';
      continue;
    }
    const value = formatOne(def, raw);
    if (value === null) issues.push({ path: def.name, message: `must be a valid ${def.type}` });
    else out[def.name] = value;
  }
  if (issues.length > 0) throw new ValidationError(issues, 'Invalid template variables');
  return out;
};

const formatOne = (def: VariableDef, raw: string | number): string | null => {
  switch (def.type) {
    case 'string': {
      const text = String(raw).replace(CONTROL, '').replace(/\s+/g, ' ').trim();
      return clip(text, def.maxLength ?? DEFAULT_MAX_LENGTH);
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      return Number.isFinite(n) ? integer.format(n) : null;
    }
    case 'money': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      return Number.isFinite(n) ? money.format(n) : null;
    }
    case 'date': {
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? null : date.format(d);
    }
  }
};

/** Replaces placeholders; unknown names render ''. `escape` is applied to every value. */
export const fill = (
  text: string,
  values: Readonly<Record<string, string>>,
  escape: (value: string) => string = (v) => v,
): string => text.replace(PLACEHOLDER, (_m, name: string) => escape(values[name] ?? ''));

/** Cuts to `max` characters with an ellipsis. */
export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

export const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** Plain text → minimal, safe email HTML (paragraphs + line breaks; everything escaped). */
export const textToHtml = (text: string): string => {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${escapeHtml(p).replaceAll('\n', '<br>')}</p>`)
    .join('');
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937">${paragraphs}</body></html>`;
};

/** One line, no control characters (SMS / subjects / push). */
export const singleLine = (text: string): string =>
  text.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
