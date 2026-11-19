import { ValidationError, type ValidationIssue } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { VariantFactsRow } from './projections.repository.js';

const COLD_CHAIN = new Set(['CC_REF', 'CC_FRZ']);

export interface VariantFacts extends VariantFactsRow {
  /** 2–8 °C or frozen: only cold-chain warehouses may hold or ship it. */
  coldChain: boolean;
}

const withCold = (row: VariantFactsRow): VariantFacts => ({
  ...row,
  coldChain: COLD_CHAIN.has(row.temperatureClass),
});

/** Read side of the product-variant projection. */
export class ProjectionsService {
  private readonly repo: Cradle['projectionsRepository'];

  constructor({ projectionsRepository }: Pick<Cradle, 'projectionsRepository'>) {
    this.repo = projectionsRepository;
  }

  async byIds(ids: readonly string[], tx?: Tx): Promise<Map<string, VariantFacts>> {
    const rows = await this.repo.findMany([...new Set(ids)], tx);
    return new Map(rows.map((r) => [r.variantId, withCold(r)]));
  }

  /**
   * Every id must be a known, ACTIVE variant (422 lists the bad ones by request path).
   * `path` builds the issue path for line i, e.g. `body.lines[2].variantId`.
   */
  async requireActive(
    ids: readonly string[],
    path: (index: number) => string,
    tx?: Tx,
  ): Promise<Map<string, VariantFacts>> {
    const byId = await this.byIds(ids, tx);
    const issues: ValidationIssue[] = [];
    ids.forEach((id, i) => {
      const v = byId.get(id);
      if (v === undefined) issues.push({ path: path(i), message: 'unknown variant' });
      else if (!v.isActive) issues.push({ path: path(i), message: 'variant is not active' });
    });
    if (issues.length > 0) throw new ValidationError(issues);
    return byId;
  }
}
