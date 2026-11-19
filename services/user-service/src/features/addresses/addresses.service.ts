import { ConflictError, NotFoundError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import { type Tx, isUniqueViolation, mapPrismaError } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from '../../adapters/uuid.js';
import type { Actor, AuditRecord } from '../audit/index.js';
import type { AddressRow } from './addresses.repository.js';
import type {
  AddressFields,
  AddressSnapshotV1,
  AddressView,
  AdminAddressView,
  CreateAddressInput,
  UpdateAddressInput,
} from './addresses.types.js';

type Deps = Pick<Cradle, 'addressesRepository' | 'runInTransaction' | 'auditService' | 'config'>;

const EDITABLE: readonly (keyof AddressFields)[] = [
  'type',
  'label',
  'contactName',
  'contactPhone',
  'line1',
  'line2',
  'landmark',
  'village',
  'mandal',
  'district',
  'stateCode',
  'pinCode',
  'latitude',
  'longitude',
];

// ── Pure helpers (exported for unit tests) ──

const num = (value: { toString(): string } | null): number | null =>
  value === null ? null : Number(value.toString());

export const toView = (row: AddressRow): AddressView => ({
  id: row.id,
  type: row.type,
  label: row.label,
  contactName: row.contactName,
  contactPhone: row.contactPhone,
  line1: row.line1,
  line2: row.line2,
  landmark: row.landmark,
  village: row.village,
  mandal: row.mandal,
  district: row.district,
  stateCode: row.stateCode,
  pinCode: row.pinCode,
  latitude: num(row.latitude),
  longitude: num(row.longitude),
  isDefault: row.isDefault,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const toAdminView = (row: AddressRow): AdminAddressView => ({
  ...toView(row),
  userId: row.userId,
  deletedAt: row.deletedAt,
});

/** `Plot 12, Near temple, Kondapur, Serilingampally, Rangareddy, TG 500084`. */
export const formatAddress = (a: AddressFields): string =>
  [a.line1, a.line2, a.landmark, a.village, a.mandal, a.district, `${a.stateCode} ${a.pinCode}`]
    .filter((part) => part !== null && part !== '')
    .join(', ');

export const toSnapshot = (row: AddressRow): AddressSnapshotV1 => {
  const view = toView(row);
  const fields = Object.fromEntries(
    EDITABLE.map((key) => [key, view[key]]),
  ) as unknown as AddressFields;
  return {
    ...fields,
    addressId: row.id,
    version: row.version,
    userId: row.userId,
    deleted: row.deletedAt !== null,
    formatted: formatAddress(fields),
  };
};

/** Only fields that really change ('' → null for optional text). */
export const diff = (changes: UpdateAddressInput, current: AddressView): Partial<AddressFields> => {
  const data: Partial<AddressFields> = {};
  for (const key of EDITABLE) {
    if (!(key in changes)) continue;
    const raw = changes[key];
    const value = raw === '' ? null : raw;
    if (value !== undefined && value !== current[key]) Object.assign(data, { [key]: value });
  }
  return data;
};

const notFound = () => new NotFoundError('Address');

/**
 * Customer addresses. Every write: one transaction under a per-user advisory lock (limit check,
 * default swap and promotion are race-free), an audit row in the same transaction. The partial
 * unique index `user_addresses_one_default` is the last line of defence.
 */
export class AddressesService {
  constructor(private readonly deps: Deps) {}

  // ── Customer reads ──

  async list(userId: string): Promise<AddressView[]> {
    return (await this.deps.addressesRepository.listLive(userId)).map(toView);
  }

  async get(userId: string, id: string): Promise<AddressView> {
    const row = await this.deps.addressesRepository.findLive(userId, id);
    if (row === null) throw notFound();
    return toView(row);
  }

  // ── Customer writes ──

  async create(input: CreateAddressInput, actor: Actor): Promise<AddressView> {
    const { isDefault, ...fields } = input;
    return this.write(actor.userId, async (tx, repo) => {
      const count = await repo.countLive(tx, actor.userId);
      const max = this.deps.config.MAX_ADDRESSES_PER_USER;
      if (count >= max)
        throw new ConflictError(`You can save at most ${String(max)} addresses`, {
          details: { reason: 'ADDRESS_LIMIT', max },
        });
      const makeDefault = count === 0 || isDefault === true;
      if (makeDefault && count > 0) await repo.clearDefault(tx, actor.userId);
      const row = await repo.create(tx, {
        type: 'HOME',
        label: null,
        line2: null,
        landmark: null,
        village: null,
        mandal: null,
        latitude: null,
        longitude: null,
        ...fields,
        id: uuidv7(),
        userId: actor.userId,
        isDefault: makeDefault,
      });
      const view = toView(row);
      await this.audit(tx, actor, 'address.create', row.id, null, view);
      return view;
    });
  }

  async update(
    id: string,
    input: UpdateAddressInput,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<AddressView> {
    return this.write(actor.userId, async (tx, repo) => {
      const current = toView(await this.owned(tx, actor.userId, id, ifMatch));
      const data = diff(input, current);
      if (Object.keys(data).length === 0) return current;
      const view = toView(await repo.update(tx, id, data));
      const before = Object.fromEntries(
        Object.keys(data).map((k) => [k, current[k as keyof AddressFields]]),
      );
      await this.audit(tx, actor, 'address.update', id, before, data);
      return view;
    });
  }

  async setDefault(id: string, actor: Actor): Promise<AddressView> {
    return this.write(actor.userId, async (tx, repo) => {
      const current = await this.owned(tx, actor.userId, id, undefined);
      if (current.isDefault) return toView(current);
      await repo.clearDefault(tx, actor.userId);
      const view = toView(await repo.update(tx, id, { isDefault: true }));
      await this.audit(tx, actor, 'address.default', id, { isDefault: false }, { isDefault: true });
      return view;
    });
  }

  /** Soft delete; when the default goes, the most recently changed address becomes default. */
  async remove(id: string, ifMatch: number | undefined, actor: Actor): Promise<void> {
    await this.write(actor.userId, async (tx, repo) => {
      const current = toView(await this.owned(tx, actor.userId, id, ifMatch));
      await repo.softDelete(tx, id);
      let promotedId: string | null = null;
      if (current.isDefault) {
        const next = await repo.newestLive(tx, actor.userId);
        if (next !== null) {
          await repo.update(tx, next.id, { isDefault: true });
          promotedId = next.id;
        }
      }
      await this.audit(tx, actor, 'address.delete', id, current, { promotedId });
    });
  }

  // ── Internal (order-service) ──

  async snapshot(userId: string, id: string): Promise<AddressSnapshotV1> {
    const row = await this.deps.addressesRepository.findAny(userId, id);
    if (row === null) throw notFound();
    return toSnapshot(row);
  }

  // ── Admin (support, read-only) ──

  async adminList(userId: string, includeDeleted: boolean): Promise<AdminAddressView[]> {
    return (await this.deps.addressesRepository.listAll(userId, includeDeleted)).map(toAdminView);
  }

  async adminHistory(
    userId: string,
    id: string,
    query: { cursor?: string; limit: number },
  ): Promise<Paginated<AuditRecord>> {
    if ((await this.deps.addressesRepository.findAny(userId, id)) === null) throw notFound();
    return this.deps.auditService.history('address', id, query);
  }

  // ── Helpers ──

  private async write<T>(
    userId: string,
    work: (tx: Tx, repo: Deps['addressesRepository']) => Promise<T>,
  ): Promise<T> {
    const repo = this.deps.addressesRepository;
    try {
      return await this.deps.runInTransaction(async (tx) => {
        await repo.lock(tx, userId);
        return work(tx, repo);
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictError('Another default address was set at the same time; retry', {
          details: { reason: 'ADDRESS_DEFAULT_RACE' },
        });
      const mapped = mapPrismaError(error);
      throw mapped instanceof Error ? mapped : error;
    }
  }

  private async owned(
    tx: Tx,
    userId: string,
    id: string,
    ifMatch: number | undefined,
  ): Promise<AddressRow> {
    const row = await this.deps.addressesRepository.findLive(userId, id, tx);
    if (row === null) throw notFound();
    if (ifMatch !== undefined && ifMatch !== row.version)
      throw new ConflictError('The address was changed elsewhere; reload and retry', {
        details: { reason: 'ADDRESS_VERSION_CONFLICT', currentVersion: row.version },
      });
    return row;
  }

  private audit(
    tx: Tx,
    actor: Actor,
    action: string,
    targetId: string,
    before: object | null,
    after: object | null,
  ): Promise<void> {
    return this.deps.auditService.record(tx, actor, {
      action,
      targetType: 'address',
      targetId,
      before,
      after,
    });
  }
}
