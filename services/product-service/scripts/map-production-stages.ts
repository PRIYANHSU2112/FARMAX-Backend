/**
 * Maps legacy free-text `products.productionStages` values (e.g. "grower", "Layer", "pre-layer")
 * to FLOCK_STAGE lookup codes (GROWER, LAYER, PRE_LAYER).
 *
 *   pnpm --filter @farmx/product-service stages:map              dry run: report only, no writes
 *   pnpm --filter @farmx/product-service stages:map -- --apply   write the mapped codes
 *
 * Mapping source = live FLOCK_STAGE lookups: code → label → meta.aliases (normalised: trim,
 * lower-case, `_`/`-`/`/` and repeated spaces → one space). Fix an UNMAPPED value by adding an
 * alias (PATCH /v1/admin/catalog/lookups/:id) or a new stage, then run again.
 *
 * --apply: one transaction per product: mapped values replaced by codes (de-duplicated), unmapped
 * values left untouched and written to `stage-mapping-unmapped.csv` for a manual edit; version
 * bumped; an audit row (before/after) per product. Idempotent: valid codes are skipped. Afterwards
 * the storefront list version is bumped and changed product pages are dropped from the cache.
 *
 * Env: DATABASE_URL (required), REDIS_CACHE_URL (optional; without it caches expire by TTL).
 */
import { writeFileSync } from 'node:fs';

import { createLogger } from '@farmx/common/logger';
import { closeDatabase, getDatabase } from '@farmx/database/client';
import { createCacheClient, productKeys } from '@farmx/infra/redis';

import {
  type StageLookup,
  buildStageIndex,
  mapStages,
} from '../src/features/products/products.stage-mapping.js';

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const BATCH = 200;
const REPORT = 'stage-mapping-unmapped.csv';
const apply = process.argv.includes('--apply');

const print = (text: string) => process.stdout.write(`${text}\n`);
const csv = (v: string) => `"${v.replaceAll('"', '""')}"`;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') throw new Error('DATABASE_URL is required');
  const db = getDatabase({
    url,
    logger: createLogger({ service: 'product-stages-map', level: 'warn' }),
    poolSize: 2,
  });

  const lookups = await db.productLookup.findMany({
    where: { group: 'FLOCK_STAGE', deletedAt: null, isActive: true },
    select: { code: true, label: true, meta: true },
  });
  const stages: StageLookup[] = lookups.map((l) => {
    const aliases = (l.meta as { aliases?: unknown }).aliases;
    return {
      code: l.code,
      label: l.label,
      aliases: Array.isArray(aliases) ? aliases.filter((a) => typeof a === 'string') : [],
    };
  });
  if (stages.length === 0)
    throw new Error('No active FLOCK_STAGE lookups: run the migration first');
  const index = buildStageIndex(stages);
  const validCodes = new Set(stages.map((s) => s.code));

  /** original value → { code | null, products } */
  const summary = new Map<string, { code: string | null; products: number }>();
  const unmappedRows: string[] = [];
  const changedSlugs: string[] = [];
  let scanned = 0;
  let toChange = 0;
  let cursor: string | undefined;

  for (;;) {
    const page = await db.product.findMany({
      where: { deletedAt: null, NOT: { productionStages: { isEmpty: true } } },
      select: { id: true, slug: true, productCode: true, productionStages: true, version: true },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    if (page.length === 0) break;
    cursor = page.at(-1)?.id;

    for (const p of page) {
      scanned += 1;
      const result = mapStages(p.productionStages, index, validCodes);
      for (const value of p.productionStages) {
        const entry = summary.get(value) ?? {
          code: result.unmapped.includes(value)
            ? null
            : (mapStages([value], index, validCodes).next[0] ?? null),
          products: 0,
        };
        entry.products += 1;
        summary.set(value, entry);
      }
      for (const value of result.unmapped)
        unmappedRows.push([p.id, p.productCode, value].map(csv).join(','));
      if (!result.changed) continue;
      toChange += 1;
      if (!apply) continue;

      await db.$transaction(async (tx) => {
        // Optimistic: skip a product edited since it was read (run again to pick it up).
        const updated = await tx.product.updateMany({
          where: { id: p.id, version: p.version },
          data: {
            productionStages: result.next,
            version: { increment: 1 },
            updatedByUserId: SYSTEM_ACTOR_ID,
          },
        });
        if (updated.count === 0) return;
        await tx.productAuditLog.create({
          data: {
            actorUserId: SYSTEM_ACTOR_ID,
            action: 'product.update',
            targetType: 'product',
            targetId: p.id,
            before: { productionStages: p.productionStages },
            after: { productionStages: result.next },
            reason: 'productionStages mapping to FLOCK_STAGE codes',
          },
        });
        changedSlugs.push(p.slug);
      });
    }
  }

  const rows = [...summary.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, { code, products }]) => [
      value,
      code === value ? `${value} (already a code)` : (code ?? 'UNMAPPED'),
      String(products),
    ]);
  const widths = [0, 1, 2].map((i) =>
    Math.max(
      ['old value', 'code', 'products'][i]?.length ?? 0,
      ...rows.map((r) => r[i]?.length ?? 0),
    ),
  );
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ');
  print(`\n${apply ? 'APPLY' : 'DRY RUN'}: products with stages: ${String(scanned)}`);
  print(line(['old value', 'code', 'products']));
  for (const row of rows) print(line(row));
  print(
    apply
      ? `Updated ${String(changedSlugs.length)} of ${String(toChange)} products needing a change.`
      : `${String(toChange)} products would change. Run with --apply to write.`,
  );
  if (unmappedRows.length > 0) {
    writeFileSync(REPORT, ['productId,productCode,value', ...unmappedRows].join('\n') + '\n');
    print(`${String(unmappedRows.length)} unmapped values → ${REPORT} (left as-is).`);
  }

  if (apply && changedSlugs.length > 0) {
    const redisUrl = process.env.REDIS_CACHE_URL;
    if (redisUrl === undefined || redisUrl === '') {
      print('REDIS_CACHE_URL not set: storefront caches expire by TTL (≤ 10 min).');
    } else {
      const redis = createCacheClient(redisUrl);
      try {
        await redis.incr(productKeys.listVersion());
        await redis.del(...changedSlugs.map((slug) => productKeys.product(slug)));
      } finally {
        redis.disconnect();
      }
    }
  }
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
