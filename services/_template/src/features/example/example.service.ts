import { NotFoundError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import type { Cradle } from '@fastify/awilix';

import type {
  CreateExampleInput,
  ExampleListQuery,
  ExampleRecord,
  ExampleView,
} from './example.types.js';

const toView = (row: ExampleRecord): ExampleView => ({
  id: row.id,
  name: row.name,
  ownerId: row.ownerId,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * Public API of the example module: business rules live here. Other modules inject it as
 * `exampleService` (rule 11). Cross-module work: `runInTransaction(tx => …)` and pass `tx`.
 */
export class ExampleService {
  private readonly exampleRepository: Cradle['exampleRepository'];

  constructor({ exampleRepository }: Pick<Cradle, 'exampleRepository'>) {
    this.exampleRepository = exampleRepository;
  }

  async list(query: ExampleListQuery): Promise<Paginated<ExampleView>> {
    const page = await this.exampleRepository.list(query);
    return { ...page, items: page.items.map(toView) };
  }

  async get(id: string): Promise<ExampleView> {
    const row = await this.exampleRepository.findById(id);
    if (row === null) throw new NotFoundError('Example');
    return toView(row);
  }

  async create(input: CreateExampleInput, ownerId: string): Promise<ExampleView> {
    return toView(await this.exampleRepository.create({ name: input.name.trim(), ownerId }));
  }
}
