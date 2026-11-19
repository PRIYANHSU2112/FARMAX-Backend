import type { Paginated } from '@farmx/common/types';
import { type Tx, withPrismaErrors } from '@farmx/database';
import type { PinCode, Territory } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type {
  PinInput,
  PinListQuery,
  PinView,
  TerritoryInput,
  TerritoryView,
} from './geo.types.js';

const toPinView = (row: PinCode): PinView => ({
  pinCode: row.pinCode,
  serviceable: row.serviceable,
  territory: { id: row.territoryId, code: row.territoryCode },
  districtName: row.districtName,
  mandalName: row.mandalName,
  villages: row.villages,
  primaryNode:
    row.primaryNodeId === null ? null : { id: row.primaryNodeId, name: row.primaryNodeName },
  backupNode: row.backupNodeId === null ? null : { id: row.backupNodeId, name: row.backupNodeName },
  deliveryPromise: row.deliveryPromise,
});

const toTerritoryView = (row: Territory): TerritoryView => ({
  id: row.id,
  code: row.code,
  name: row.name,
  districtName: row.districtName,
  stateCode: row.stateCode,
  isActive: row.isActive,
});

/** Only place that queries `territories` and `pin_codes`. */
export class GeoRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async findPin(pinCode: string): Promise<PinView | null> {
    const row = await withPrismaErrors(() => this.db.pinCode.findUnique({ where: { pinCode } }));
    return row === null ? null : toPinView(row);
  }

  async listPins(query: PinListQuery): Promise<Paginated<PinView>> {
    const rows = await withPrismaErrors(() =>
      this.db.pinCode.findMany({
        where: {
          ...(query.territoryCode === undefined ? {} : { territoryCode: query.territoryCode }),
          ...(query.cursor === undefined ? {} : { pinCode: { gt: query.cursor } }),
        },
        orderBy: { pinCode: 'asc' },
        take: query.limit + 1,
      }),
    );
    // Keyset on the pin code itself (the primary key): `cursor` = last pin of the previous page.
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map(toPinView);
    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.pinCode ?? null) : null,
      limit: query.limit,
    };
  }

  async upsertPin(
    tx: Tx,
    pinCode: string,
    territoryId: string,
    input: Omit<PinInput, 'reason'>,
  ): Promise<PinView> {
    const data = {
      territoryId,
      territoryCode: input.territoryCode,
      districtName: input.districtName,
      mandalName: input.mandalName ?? null,
      villages: input.villages ?? [],
      primaryNodeId: input.primaryNodeId ?? null,
      primaryNodeName: input.primaryNodeName ?? null,
      backupNodeId: input.backupNodeId ?? null,
      backupNodeName: input.backupNodeName ?? null,
      deliveryPromise: input.deliveryPromise ?? null,
      serviceable: input.serviceable ?? true,
    };
    const row = await tx.pinCode.upsert({
      where: { pinCode },
      create: { pinCode, ...data },
      update: data,
    });
    return toPinView(row);
  }

  async listTerritories(): Promise<TerritoryView[]> {
    const rows = await withPrismaErrors(() =>
      this.db.territory.findMany({ orderBy: { code: 'asc' } }),
    );
    return rows.map(toTerritoryView);
  }

  async findTerritoryByCode(code: string): Promise<TerritoryView | null> {
    const row = await withPrismaErrors(() => this.db.territory.findUnique({ where: { code } }));
    return row === null ? null : toTerritoryView(row);
  }

  async createTerritory(tx: Tx, input: TerritoryInput): Promise<TerritoryView> {
    return toTerritoryView(await tx.territory.create({ data: input }));
  }

  async updateTerritory(
    tx: Tx,
    id: string,
    input: Partial<TerritoryInput>,
  ): Promise<TerritoryView> {
    return toTerritoryView(await tx.territory.update({ where: { id }, data: input }));
  }
}
