import type { Cradle } from '@fastify/awilix';

import type { FarmFacts, VariantFacts } from './projections.types.js';

/** Public read API of the projections (other features inject `projectionsService`). */
export class ProjectionsService {
  private readonly repo: Cradle['projectionsRepository'];

  constructor({ projectionsRepository }: Pick<Cradle, 'projectionsRepository'>) {
    this.repo = projectionsRepository;
  }

  variants(ids: readonly string[]): Promise<VariantFacts[]> {
    return ids.length === 0 ? Promise.resolve([]) : this.repo.variants(ids);
  }

  farm(farmId: string): Promise<FarmFacts | null> {
    return this.repo.farm(farmId);
  }
}
