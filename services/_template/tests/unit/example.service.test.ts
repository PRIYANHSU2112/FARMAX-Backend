import { describe, expect, it } from 'vitest';

import { ExampleRepository } from '../../src/features/example/example.repository.js';
import { ExampleService } from '../../src/features/example/example.service.js';

const setup = () => ({
  service: new ExampleService({ exampleRepository: new ExampleRepository() }),
});

describe('ExampleService', () => {
  it('creates (trimmed name, owner) and reads back', async () => {
    const { service } = setup();
    const created = await service.create({ name: '  First ' }, 'owner-1');
    expect(created).toMatchObject({ name: 'First', ownerId: 'owner-1' });
    await expect(service.get(created.id)).resolves.toEqual(created);
  });

  it('404s on an unknown id', async () => {
    const { service } = setup();
    await expect(service.get('01900000-0000-7000-8000-000000000999')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('lists newest first with cursor pagination', async () => {
    const { service } = setup();
    for (const name of ['a', 'b', 'c']) await service.create({ name }, 'o');
    const first = await service.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });
});
