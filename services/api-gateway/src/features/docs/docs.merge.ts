/**
 * Pure merge of every service's OpenAPI 3.0.3 spec into ONE document with public gateway paths
 * (D-29). No I/O here; `docs.service.ts` fetches the specs.
 */

export type OpenApiDoc = Record<string, unknown> & {
  info?: Record<string, unknown>;
  tags?: { name: string; description?: string }[];
  paths?: Record<string, Record<string, unknown>>;
  components?: Record<string, Record<string, unknown> | undefined>;
};

export interface DocsSource {
  /** Service name shown in the overview, e.g. `catalog-service`. */
  service: string;
  /** Internal base URL; the spec is read from `<baseUrl>/api-docs.json`. */
  baseUrl: string;
  /** Gateway prefix that maps onto the service's paths, e.g. `/v1/auth` or `/v1`. */
  publicPrefix: string;
  /** One-line summary for the overview. */
  summary: string;
}

export interface FetchedSpec {
  source: DocsSource;
  /** null = unavailable (and no earlier copy). */
  spec: OpenApiDoc | null;
  /** Why the live fetch failed (the spec may still be the last good copy). */
  error?: string;
}

const SKIPPED_PATH = /^\/(health|internal)(\/|$)/;
const SKIPPED_TAGS = new Set(['Health']);
const COMPONENT_KINDS = [
  'schemas',
  'responses',
  'parameters',
  'requestBodies',
  'headers',
  'securitySchemes',
] as const;

export interface MergeResult {
  doc: OpenApiDoc;
  /** `METHOD path` (or component name) defined by two services; the first one is kept. */
  collisions: string[];
}

export function mergeSpecs(
  fetched: readonly FetchedSpec[],
  info: { title: string; version: string },
): MergeResult {
  const paths: Record<string, Record<string, unknown>> = {};
  const tags: { name: string; description?: string }[] = [];
  const tagNames = new Set<string>();
  const components: Record<string, Record<string, unknown>> = {};
  const collisions: string[] = [];

  for (const { source, spec } of fetched) {
    if (spec === null) continue;

    for (const tag of spec.tags ?? []) {
      if (SKIPPED_TAGS.has(tag.name) || tagNames.has(tag.name)) continue;
      tagNames.add(tag.name);
      tags.push({
        name: tag.name,
        description: `\`${source.service}\` · ${tag.description ?? ''}`.trim(),
      });
    }

    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      if (SKIPPED_PATH.test(path)) continue;
      const publicPath = `${source.publicPrefix}${path}`.replace(/\/{2,}/g, '/');
      const target = (paths[publicPath] ??= {});
      for (const [method, operation] of Object.entries(item)) {
        if (method in target) {
          collisions.push(`${method.toUpperCase()} ${publicPath}`);
          continue;
        }
        target[method] = operation;
      }
    }

    for (const kind of COMPONENT_KINDS) {
      const incoming = spec.components?.[kind];
      if (incoming === undefined) continue;
      const merged = (components[kind] ??= {});
      for (const [name, value] of Object.entries(incoming)) {
        if (!(name in merged)) merged[name] = value;
        else if (JSON.stringify(merged[name]) !== JSON.stringify(value))
          collisions.push(`components.${kind}.${name}`);
      }
    }
  }

  // Keep the section order of the services, but drop sections that have no route yet.
  const used = new Set(
    Object.values(paths).flatMap((item) =>
      Object.values(item).flatMap((op) => (op as { tags?: string[] }).tags ?? []),
    ),
  );

  return {
    doc: {
      openapi: '3.0.3',
      info: {
        title: info.title,
        version: info.version,
        description: overview(fetched, tags, used),
      },
      servers: [{ url: '/', description: 'This API gateway (same origin)' }],
      tags: tags.filter((tag) => used.has(tag.name)),
      paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
      components,
    },
    collisions,
  };
}

function overview(
  fetched: readonly FetchedSpec[],
  tags: readonly { name: string }[],
  used: ReadonlySet<string>,
): string {
  const services = fetched.map(({ source, spec, error }) => {
    const status =
      spec === null
        ? `⚠️ unavailable (${error ?? 'no spec'})`
        : error === undefined
          ? '✅'
          : `⚠️ showing the last good copy (${error})`;
    return `| \`${source.service}\` | \`${source.publicPrefix}\` | ${source.summary} | ${status} |`;
  });
  const links = tags
    .filter((tag) => used.has(tag.name))
    .map((tag) => `[${tag.name}](#/${encodeURIComponent(tag.name)})`);
  return [
    'One API reference for every FarmX service, served by the API gateway. All paths below are the public gateway paths; **Try it out** calls them on this same origin.',
    '| Service | Prefix | Covers | Spec |\n| --- | --- | --- | --- |\n' + services.join('\n'),
    'Conventions: `{ success, data, meta? }` / `{ success: false, error: { code, message, details?, requestId } }` envelope · cursor pagination (`cursor`, `limit` ≤ 100) · `If-Match: <version>` on admin writes · `Idempotency-Key` on creating POSTs · 422 lists every invalid field · health probes: `/health/live`, `/health/ready` (gateway), `/v1/<service>/health/*`.',
    links.length > 0 ? `**Jump to:** ${links.join(' · ')}` : '',
    '🔒 = needs a Bearer token (click **Authorize**). Routes without a lock are public.',
  ]
    .filter((line) => line !== '')
    .join('\n\n');
}
