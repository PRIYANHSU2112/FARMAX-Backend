import { type Tx, advisoryXactLock, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { AddressFields } from './addresses.types.js';

const SELECT = {
  id: true,
  userId: true,
  type: true,
  label: true,
  contactName: true,
  contactPhone: true,
  line1: true,
  line2: true,
  landmark: true,
  village: true,
  mandal: true,
  district: true,
  stateCode: true,
  pinCode: true,
  latitude: true,
  longitude: true,
  isDefault: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} satisfies Prisma.UserAddressSelect;

export type AddressRow = Prisma.UserAddressGetPayload<{ select: typeof SELECT }>;

/** Default first, then most recently changed. */
const ORDER: Prisma.UserAddressOrderByWithRelationInput[] = [
  { isDefault: 'desc' },
  { updatedAt: 'desc' },
  { id: 'desc' },
];

type Client = Cradle['db'] | Tx;

/** Only place that queries `user_addresses`. Every query is scoped by `userId` (no IDOR). */
export class AddressesRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** Serialises ONE user's address writes (default swap, limit check); other users never wait. */
  lock(tx: Tx, userId: string): Promise<void> {
    return advisoryXactLock(tx, `user:addr:${userId}`);
  }

  listLive(userId: string): Promise<AddressRow[]> {
    return withPrismaErrors(() =>
      this.db.userAddress.findMany({
        where: { userId, deletedAt: null },
        select: SELECT,
        orderBy: ORDER,
      }),
    );
  }

  listAll(userId: string, includeDeleted: boolean): Promise<AddressRow[]> {
    return withPrismaErrors(() =>
      this.db.userAddress.findMany({
        where: { userId, ...(includeDeleted ? {} : { deletedAt: null }) },
        select: SELECT,
        orderBy: ORDER,
      }),
    );
  }

  findLive(userId: string, id: string, client: Client = this.db): Promise<AddressRow | null> {
    return withPrismaErrors(() =>
      client.userAddress.findFirst({ where: { id, userId, deletedAt: null }, select: SELECT }),
    );
  }

  /** Including soft-deleted rows (order snapshot, support history). */
  findAny(userId: string, id: string): Promise<AddressRow | null> {
    return withPrismaErrors(() =>
      this.db.userAddress.findFirst({ where: { id, userId }, select: SELECT }),
    );
  }

  countLive(tx: Tx, userId: string): Promise<number> {
    return tx.userAddress.count({ where: { userId, deletedAt: null } });
  }

  /** Clears the current default (if any) so a new one can be set without breaking the index. */
  async clearDefault(tx: Tx, userId: string): Promise<void> {
    await tx.userAddress.updateMany({
      where: { userId, isDefault: true, deletedAt: null },
      data: { isDefault: false, version: { increment: 1 } },
    });
  }

  create(
    tx: Tx,
    data: AddressFields & { id: string; userId: string; isDefault: boolean },
  ): Promise<AddressRow> {
    return tx.userAddress.create({ data, select: SELECT });
  }

  update(
    tx: Tx,
    id: string,
    data: Partial<AddressFields> & { isDefault?: boolean },
  ): Promise<AddressRow> {
    return tx.userAddress.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
      select: SELECT,
    });
  }

  async softDelete(tx: Tx, id: string): Promise<void> {
    await tx.userAddress.update({
      where: { id },
      data: { deletedAt: new Date(), isDefault: false, version: { increment: 1 } },
    });
  }

  /** The live address to promote when the default is deleted. */
  newestLive(tx: Tx, userId: string): Promise<{ id: string } | null> {
    return tx.userAddress.findFirst({
      where: { userId, deletedAt: null },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
  }
}
