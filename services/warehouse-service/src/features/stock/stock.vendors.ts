import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import { isUniqueViolation } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';
import type { Caller } from '../../middleware/guards.js';
import { OWNER_LABEL } from './stock.rules.js';
import type { VendorInput, VendorVariantInput } from './stock.types.js';

const actorOf = (c: Caller) => ({ userId: c.userId, ip: c.ip, requestId: c.requestId });

/** Minimal vendor master (D-57a, until W22): supplier of a SKU and its ownership model. */
export class StockVendors {
  constructor(
    private readonly deps: Pick<
      Cradle,
      'stockRepository' | 'stockService' | 'runInTransaction' | 'auditService'
    >,
  ) {}

  async list(q: {
    q?: string;
    variantId?: string;
    status?: string;
    cursor?: string;
    limit: number;
  }) {
    const rows = await this.deps.stockRepository.vendors(q);
    const items = rows.slice(0, q.limit).map((v) => ({
      id: v.id,
      code: v.code,
      name: v.name,
      gstin: v.gstin,
      phone: v.phone,
      email: v.email,
      defaultOwnership: v.defaultOwnership,
      ownership: OWNER_LABEL[v.defaultOwnership],
      status: v.status,
      version: v.version,
    }));
    return {
      items,
      nextCursor: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null,
      limit: q.limit,
    };
  }

  async get(id: string) {
    const v = await this.deps.stockRepository.vendor(id);
    if (v === null) throw new NotFoundError('Vendor');
    const skus = new Map(
      (await this.deps.stockRepository.variants(v.variants.map((x) => x.variantId))).map((x) => [
        x.variantId,
        x,
      ]),
    );
    return {
      ...v,
      ownership: OWNER_LABEL[v.defaultOwnership],
      variants: v.variants.map((x) => ({
        ...x,
        sku: skus.get(x.variantId)?.sku ?? null,
        productName: skus.get(x.variantId)?.name ?? null,
        ownership: OWNER_LABEL[x.ownershipModel],
      })),
    };
  }

  async create(caller: Caller, input: VendorInput) {
    return this.deps.runInTransaction(async (tx) => {
      const v = await this.deps.stockRepository
        .createVendor(tx, {
          code: input.code,
          name: input.name,
          gstin: input.gstin ?? null,
          phone: input.phone ?? null,
          email: input.email ?? null,
          defaultOwnership: input.defaultOwnership ?? 'FARMX',
          status: input.status ?? 'ACTIVE',
          createdByUserId: caller.userId,
          updatedByUserId: caller.userId,
        })
        .catch((err: unknown) => {
          if (isUniqueViolation(err))
            throw new ConflictError(`Vendor code ${input.code} already exists`, {
              details: { reason: 'DUPLICATE_CODE' },
            });
          throw err;
        });
      await this.deps.auditService.record(tx, actorOf(caller), {
        action: 'vendor.created',
        targetType: 'vendor',
        targetId: v.id,
        after: input,
      });
      return v;
    });
  }

  async update(
    caller: Caller,
    id: string,
    input: Partial<VendorInput> & { expectedVersion: number },
  ) {
    const { expectedVersion, ...data } = input;
    await this.deps.runInTransaction(async (tx) => {
      const before = await this.deps.stockRepository.vendor(id, tx);
      if (before === null) throw new NotFoundError('Vendor');
      const okWrite = await this.deps.stockRepository.updateVendor(tx, id, expectedVersion, {
        ...data,
        updatedByUserId: caller.userId,
      });
      if (!okWrite)
        throw new ConflictError('The vendor changed; reload and retry', {
          details: { reason: 'VERSION_CONFLICT' },
        });
      await this.deps.auditService.record(tx, actorOf(caller), {
        action: 'vendor.updated',
        targetType: 'vendor',
        targetId: id,
        before: {
          name: before.name,
          status: before.status,
          defaultOwnership: before.defaultOwnership,
        },
        after: data,
      });
    });
    return this.get(id);
  }

  async setVariants(caller: Caller, id: string, rows: VendorVariantInput[]) {
    const known = await this.deps.stockService.ensureVariants(rows.map((r) => r.variantId));
    const bad = rows.flatMap((r, i) =>
      known.some((k) => k.variantId === r.variantId)
        ? []
        : [{ path: `body.${i}.variantId`, message: 'unknown SKU' }],
    );
    if (bad.length > 0) throw new ValidationError(bad);
    await this.deps.runInTransaction(async (tx) => {
      if ((await this.deps.stockRepository.vendor(id, tx)) === null)
        throw new NotFoundError('Vendor');
      await this.deps.stockRepository.replaceVendorVariants(
        tx,
        id,
        rows.map((r) => ({
          variantId: r.variantId,
          ownershipModel: r.ownershipModel,
          leadTimeDays: r.leadTimeDays ?? 7,
          moq: r.moq ?? 1,
          isPreferred: r.isPreferred ?? false,
          requiresUnitQr: r.requiresUnitQr ?? false,
        })),
      );
      await this.deps.auditService.record(tx, actorOf(caller), {
        action: 'vendor.variants_set',
        targetType: 'vendor',
        targetId: id,
        after: { rows },
      });
    });
    return this.get(id);
  }
}
