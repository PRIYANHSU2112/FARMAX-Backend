import type { CursorQuery } from '@farmx/common/types';

/** Row shape returned by the repository (no Prisma types leak past it). */
export interface ExampleRecord {
  id: string;
  name: string;
  ownerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** API representation. */
export interface ExampleView {
  id: string;
  name: string;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExampleListQuery extends CursorQuery {
  q?: string;
}

export interface CreateExampleInput {
  name: string;
}
