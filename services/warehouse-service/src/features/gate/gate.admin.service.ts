import { ConflictError, NotFoundError } from '@farmx/common/errors';
import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import { GATE_SETTING_KEYS, type GateSettings } from './gate.rules.js';
import { conflict, isDuplicate } from './gate.support.js';

export interface ScaleInput {
  code: string;
  name: string;
  maxCapacityKg: number;
  divisionKg?: number;
  calibratedAt?: string | null;
  calibrationValidUntil?: string | null;
  status?: 'ACTIVE' | 'INACTIVE' | 'MAINTENANCE';
}

const day = (s: string | null | undefined) =>
  s === undefined ? undefined : s === null ? null : new Date(`${s}T00:00:00.000Z`);

/**
 * Gate administration (D-62): weighbridge scales (calibration — a reading on an expired scale is
 * refused) and the gate settings of a warehouse (tolerance, packaging allowance, required
 * documents, slot length, delay grace, pass validity, retention).
 */
export class GateAdminService {
  constructor(
    private readonly deps: Pick<
      Cradle,
      'gateRepository' | 'gateSupport' | 'gateWeighbridge' | 'runInTransaction'
    >,
  ) {}

  private get repo() {
    return this.deps.gateRepository;
  }
  private get support() {
    return this.deps.gateSupport;
  }

  async scales(caller: Caller, warehouseId: string) {
    return this.deps.gateWeighbridge.scales(caller, warehouseId);
  }

  async createScale(caller: Caller, warehouseId: string, input: ScaleInput) {
    const w = await this.support.warehouse(caller, warehouseId, 'gate.configure');
    try {
      const s = await this.deps.runInTransaction(async (tx) => {
        const row = await this.repo.createScale(tx, {
          warehouseId: w.id,
          code: input.code,
          name: input.name,
          maxCapacityKg: input.maxCapacityKg,
          divisionKg: input.divisionKg ?? 10,
          calibratedAt: day(input.calibratedAt) ?? null,
          calibrationValidUntil: day(input.calibrationValidUntil) ?? null,
          status: input.status ?? 'ACTIVE',
          createdBy: caller.userId,
          updatedBy: caller.userId,
        });
        await this.support.audit(tx, caller, 'gate.scale_created', 'weigh_scale', row.id, {
          ...input,
        });
        return row;
      });
      await this.support.bump(w.id);
      return this.deps.gateWeighbridge.scaleView(s, this.support.today(w).date);
    } catch (error) {
      if (isDuplicate(error))
        throw conflict('DUPLICATE_CODE', `Scale ${input.code} already exists in this warehouse`);
      throw error;
    }
  }

  async updateScale(
    caller: Caller,
    warehouseId: string,
    id: string,
    input: Partial<ScaleInput> & { expectedVersion: number },
  ) {
    const w = await this.support.warehouse(caller, warehouseId, 'gate.configure');
    const cur = await this.repo.scale(id);
    if (cur?.warehouseId !== w.id) throw new NotFoundError('Scale');
    try {
      const s = await this.deps.runInTransaction(async (tx) => {
        const row = await this.repo.updateScaleVersioned(tx, id, input.expectedVersion, {
          ...(input.code === undefined ? {} : { code: input.code }),
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.maxCapacityKg === undefined ? {} : { maxCapacityKg: input.maxCapacityKg }),
          ...(input.divisionKg === undefined ? {} : { divisionKg: input.divisionKg }),
          ...(input.calibratedAt === undefined ? {} : { calibratedAt: day(input.calibratedAt) }),
          ...(input.calibrationValidUntil === undefined
            ? {}
            : { calibrationValidUntil: day(input.calibrationValidUntil) }),
          ...(input.status === undefined ? {} : { status: input.status }),
          updatedBy: caller.userId,
        });
        if (row === null)
          throw new ConflictError('The scale was changed by someone else; reload it', {
            details: { reason: 'VERSION_CONFLICT' },
          });
        await this.support.audit(
          tx,
          caller,
          'gate.scale_updated',
          'weigh_scale',
          id,
          { ...input },
          { version: cur.version },
        );
        return row;
      });
      await this.support.bump(w.id);
      return this.deps.gateWeighbridge.scaleView(s, this.support.today(w).date);
    } catch (error) {
      if (isDuplicate(error)) throw conflict('DUPLICATE_CODE', 'That scale code already exists');
      throw error;
    }
  }

  async deleteScale(caller: Caller, warehouseId: string, id: string) {
    const w = await this.support.warehouse(caller, warehouseId, 'gate.configure');
    const cur = await this.repo.scale(id);
    if (cur?.warehouseId !== w.id) throw new NotFoundError('Scale');
    await this.deps.runInTransaction(async (tx) => {
      if (await this.repo.scaleUsed(tx, id))
        throw conflict('SCALE_IN_USE', 'The scale has readings; set it INACTIVE instead');
      await this.repo.deleteScale(tx, id);
      await this.support.audit(tx, caller, 'gate.scale_deleted', 'weigh_scale', id, null, {
        code: cur.code,
      });
    });
    await this.support.bump(w.id);
  }

  async settings(caller: Caller, warehouseId: string) {
    const w = await this.support.warehouse(caller, warehouseId, 'gate.view');
    return { warehouseId: w.id, values: await this.support.settings(w.id) };
  }

  /** Per-warehouse overrides (partial: only the keys sent). */
  async putSettings(caller: Caller, warehouseId: string, values: Partial<GateSettings>) {
    const w = await this.support.warehouse(caller, warehouseId, 'gate.configure');
    const before = await this.support.settings(w.id);
    await this.deps.runInTransaction(async (tx) => {
      for (const k of GATE_SETTING_KEYS)
        if (values[k] !== undefined)
          await this.support.saveSetting(tx, k, values[k], caller.userId, w.id);
      await this.support.audit(
        tx,
        caller,
        'gate.settings_updated',
        'gate_settings',
        w.id,
        values,
        before,
      );
    });
    this.support.invalidateSettings(w.id);
    await this.support.bump(w.id);
    return this.settings(caller, warehouseId);
  }
}
