import type { Paginated } from '@farmx/common/types';
import { cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { Prisma } from '@farmx/database/client';
import type { Tx } from '@farmx/database';
import type {
  LoginUserRecord,
  UserContact,
  UserListQuery,
  UserRecord,
  UserType,
} from './users.types.js';

/** Columns returned to the service. Never select anything credential-related. */
const userSelect = {
  id: true,
  userType: true,
  email: true,
  emailVerifiedAt: true,
  phone: true,
  phoneVerifiedAt: true,
  username: true,
  fullName: true,
  displayName: true,
  avatarUrl: true,
  employeeCode: true,
  preferredLanguage: true,
  timezone: true,
  status: true,
  statusReason: true,
  statusChangedAt: true,
  mfaRequired: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} satisfies Prisma.UserSelect;

export type CreateUserData = Pick<
  Prisma.UserUncheckedCreateInput,
  | 'userType'
  | 'email'
  | 'phone'
  | 'username'
  | 'fullName'
  | 'displayName'
  | 'employeeCode'
  | 'preferredLanguage'
  | 'timezone'
  | 'status'
  | 'statusChangedAt'
  | 'mfaRequired'
  | 'mustChangePassword'
  | 'createdByUserId'
  | 'registrationSource'
>;

export type UpdateUserData = Pick<
  Prisma.UserUncheckedUpdateInput,
  | 'email'
  | 'emailVerifiedAt'
  | 'phone'
  | 'phoneVerifiedAt'
  | 'username'
  | 'fullName'
  | 'displayName'
  | 'avatarUrl'
  | 'employeeCode'
  | 'preferredLanguage'
  | 'timezone'
  | 'mfaRequired'
  | 'status'
  | 'statusReason'
  | 'statusChangedAt'
  | 'deletedAt'
>;

const loginSelect = {
  id: true,
  userType: true,
  status: true,
  deletedAt: true,
  mfaRequired: true,
  mustChangePassword: true,
  email: true,
  phone: true,
  username: true,
  fullName: true,
} satisfies Prisma.UserSelect;

/** The only code that touches `users`. */
export class UsersRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async findById(id: string, tx?: Tx): Promise<UserRecord | null> {
    const db = tx ?? this.db;
    return withPrismaErrors(() => db.user.findUnique({ where: { id }, select: userSelect }));
  }

  /** Newest first (UUID v7), keyset-paginated, with search and filters. */
  async list(query: UserListQuery): Promise<Paginated<UserRecord>> {
    const q = query.q?.trim();
    const where: Prisma.UserWhereInput = {
      ...(query.includeDeleted ? {} : { deletedAt: null }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.userType === undefined ? {} : { userType: query.userType }),
      ...(q === undefined || q === ''
        ? {}
        : {
            OR: [
              { email: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q } },
              { username: { contains: q, mode: 'insensitive' } },
              { fullName: { contains: q, mode: 'insensitive' } },
              { employeeCode: { contains: q, mode: 'insensitive' } },
            ],
          }),
    };
    const rows = await withPrismaErrors(() =>
      this.db.user.findMany({
        where,
        select: userSelect,
        orderBy: { id: 'desc' },
        ...cursorArgs(query),
      }),
    );
    return toPage(rows, query.limit);
  }

  async create(data: CreateUserData, tx?: Tx): Promise<UserRecord> {
    const db = tx ?? this.db;
    return withPrismaErrors(() => db.user.create({ data, select: userSelect }));
  }

  async update(id: string, data: UpdateUserData, tx?: Tx): Promise<UserRecord> {
    const db = tx ?? this.db;
    return withPrismaErrors(() => db.user.update({ where: { id }, data, select: userSelect }));
  }

  /** How many of `ids` are ACTIVE and not deleted. */
  async countActive(ids: readonly string[], tx?: Tx): Promise<number> {
    if (ids.length === 0) return 0;
    const db = tx ?? this.db;
    return withPrismaErrors(() =>
      db.user.count({ where: { id: { in: [...ids] }, status: 'ACTIVE', deletedAt: null } }),
    );
  }

  // ── Login lookups (auth feature uses these through usersService) ────────────────────────

  /** Minimal columns for authentication decisions. Unique lookups (indexed). */
  async findLoginUser(
    where: { id: string } | { email: string } | { phone: string } | { username: string },
  ): Promise<LoginUserRecord | null> {
    return withPrismaErrors(() => this.db.user.findUnique({ where, select: loginSelect }));
  }

  /** Self sign-up through a verified OTP: ACTIVE customer with a verified phone. */
  async createSelfCustomer(phone: string, now: Date): Promise<LoginUserRecord> {
    return withPrismaErrors(() =>
      this.db.user.create({
        data: {
          userType: 'CUSTOMER',
          phone,
          phoneVerifiedAt: now,
          fullName: '',
          status: 'ACTIVE',
          statusChangedAt: now,
          registrationSource: 'self',
        },
        select: loginSelect,
      }),
    );
  }

  /** Phone proven by OTP: verify it, and activate a pending account. */
  async markPhoneVerified(id: string, activate: boolean, now: Date): Promise<void> {
    await withPrismaErrors(() =>
      this.db.user.update({
        where: { id },
        data: {
          phoneVerifiedAt: now,
          ...(activate ? { status: 'ACTIVE', statusChangedAt: now } : {}),
        },
        select: { id: true },
      }),
    );
  }

  async recordLogin(
    id: string,
    ip: string | null,
    deviceId: string | null,
    now: Date,
  ): Promise<void> {
    await withPrismaErrors(() =>
      this.db.user.update({
        where: { id },
        data: { lastLoginAt: now, lastLoginIp: ip, lastLoginDeviceId: deviceId },
        select: { id: true },
      }),
    );
  }

  async setMustChangePassword(id: string, value: boolean, tx?: Tx): Promise<void> {
    const db = tx ?? this.db;
    await withPrismaErrors(() =>
      db.user.update({ where: { id }, data: { mustChangePassword: value }, select: { id: true } }),
    );
  }

  // ── Internal lookups (notification-service, /internal/users) ─────────────────────────────

  /** Delivery details of one user (never credentials). Null when unknown or deleted. */
  async findContact(id: string): Promise<UserContact | null> {
    const row = await withPrismaErrors(() =>
      this.db.user.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true,
          userType: true,
          status: true,
          fullName: true,
          email: true,
          emailVerifiedAt: true,
          phone: true,
          phoneVerifiedAt: true,
          preferredLanguage: true,
        },
      }),
    );
    if (row === null) return null;
    return {
      id: row.id,
      userType: row.userType,
      status: row.status,
      fullName: row.fullName,
      email: row.email,
      emailVerified: row.emailVerifiedAt !== null,
      phone: row.phone,
      phoneVerified: row.phoneVerifiedAt !== null,
      preferredLanguage: row.preferredLanguage,
    };
  }

  /** Contacts of many users in one query (live users only; unknown ids are simply missing). */
  async findContacts(ids: readonly string[]): Promise<UserContact[]> {
    if (ids.length === 0) return [];
    const rows = await withPrismaErrors(() =>
      this.db.user.findMany({
        where: { id: { in: [...ids] }, deletedAt: null },
        select: {
          id: true,
          userType: true,
          status: true,
          fullName: true,
          email: true,
          emailVerifiedAt: true,
          phone: true,
          phoneVerifiedAt: true,
          preferredLanguage: true,
        },
      }),
    );
    return rows.map((row) => ({
      id: row.id,
      userType: row.userType,
      status: row.status,
      fullName: row.fullName,
      email: row.email,
      emailVerified: row.emailVerifiedAt !== null,
      phone: row.phone,
      phoneVerified: row.phoneVerifiedAt !== null,
      preferredLanguage: row.preferredLanguage,
    }));
  }

  /** ACTIVE user ids of one type, ascending (keyset page after `cursor`). */
  async listActiveIds(
    userType: UserType,
    cursor: string | undefined,
    limit: number,
  ): Promise<string[]> {
    const rows = await withPrismaErrors(() =>
      this.db.user.findMany({
        where: {
          userType,
          status: 'ACTIVE',
          deletedAt: null,
          ...(cursor === undefined ? {} : { id: { gt: cursor } }),
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: limit,
      }),
    );
    return rows.map((row) => row.id);
  }

  /** The subset of `ids` that are ACTIVE users of `userType`. */
  async filterActiveIds(ids: readonly string[], userType: UserType): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await withPrismaErrors(() =>
      this.db.user.findMany({
        where: { id: { in: [...ids] }, userType, status: 'ACTIVE', deletedAt: null },
        select: { id: true },
        orderBy: { id: 'asc' },
      }),
    );
    return rows.map((row) => row.id);
  }
}
