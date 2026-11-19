import type { Logger } from '@farmx/common/logger';

import { type DocsSource, type FetchedSpec, type OpenApiDoc, mergeSpecs } from './docs.merge.js';

export interface DocsAggregatorOptions {
  sources: readonly DocsSource[];
  logger: Logger;
  version: string;
  /** How long a merged document is reused. Default 15 s. */
  ttlMs?: number;
  /** Per-service fetch timeout. Default 2 s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Builds the single FarmX OpenAPI document: fetches every service's `/api-docs.json` in
 * parallel (timeout each), merges them, reuses the result for `ttlMs` and shares one in-flight
 * build between concurrent requests. A service that is down keeps its last good spec.
 */
export class DocsAggregator {
  private cached: { at: number; doc: OpenApiDoc } | undefined;
  private inflight: Promise<OpenApiDoc> | undefined;
  private readonly lastGood = new Map<string, OpenApiDoc>();
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: DocsAggregatorOptions) {
    this.ttlMs = options.ttlMs ?? 15_000;
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.fetchFn = options.fetch ?? fetch;
  }

  get(): Promise<OpenApiDoc> {
    if (this.cached !== undefined && Date.now() - this.cached.at < this.ttlMs) {
      return Promise.resolve(this.cached.doc);
    }
    this.inflight ??= this.build().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async build(): Promise<OpenApiDoc> {
    const fetched = await Promise.all(this.options.sources.map((source) => this.fetchOne(source)));
    const { doc, collisions } = mergeSpecs(fetched, {
      title: 'FarmX API',
      version: this.options.version,
    });
    if (collisions.length > 0) {
      this.options.logger.warn({ collisions }, 'API docs: duplicate paths/components (first kept)');
    }
    this.cached = { at: Date.now(), doc };
    return doc;
  }

  private async fetchOne(source: DocsSource): Promise<FetchedSpec> {
    try {
      const res = await this.fetchFn(`${source.baseUrl}/api-docs.json`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      const spec = (await res.json()) as OpenApiDoc;
      this.lastGood.set(source.service, spec);
      return { source, spec };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.options.logger.warn({ service: source.service, error }, 'API docs: spec unavailable');
      return { source, spec: this.lastGood.get(source.service) ?? null, error };
    }
  }
}
