import { ConflictError } from '@farmx/common/errors';
import { type Tx, isUniqueViolation } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import { emitWarehouseEvent } from '../../adapters/events.js';
import { bumpGateVersion } from '../../adapters/gate-version.js';
import type { Caller } from '../../middleware/guards.js';
import { num } from '../../middleware/http.js';
import { dayBounds, localDate } from '../../middleware/time.js';
import type { AuditTarget } from '../audit/index.js';
import type { DocKind } from '../stock/index.js';
import type { WarehouseRecord } from '../warehouses/index.js';
import type { EntryRow, ShipmentRow } from './gate.repository.js';
import {
  type EntryStatus,
  GATE_DEFAULTS,
  GATE_SETTING_KEYS,
  type GateSettings,
  sanitizeAudit,
  stageOf,
} from './gate.rules.js';

/**
 * A unique-key violation, raw or already mapped by `withPrismaErrors` (the mapped 409 keeps the
 * Prisma error as its cause; the adapter does not name the index, so callers re-read).
 */
export const isDuplicate = (error: unknown): boolean =>
  isUniqueViolation(error) || (error instanceof Error && isUniqueViolation(error.cause));

/** 409 with a machine reason (`details.reason`). */
export const conflict = (reason: string, message: string, extra: object = {}) =>
  new ConflictError(message, { details: { reason, ...extra } });

/** Another request moved the entry / shipment first. */
export const stale = (status: string) =>
  conflict('STALE_STATE', `Not allowed while ${status.replaceAll('_', ' ').toLowerCase()}`, {
    status,
  });

const actorOf = (c: Caller | null) => ({
  userId: c?.userId ?? null,
  ip: c?.ip ?? null,
  requestId: c?.requestId ?? null,
});

const KEY_SETTINGS_TTL = 15_000;

/**
 * Shared gate plumbing (D-62): warehouse access + timezone, settings (code defaults ← GLOBAL ←
 * warehouse), document numbers, the gate timeline, masked audit rows, the outbox status event,
 * the shipment stage mirror and the post-commit cache version bump.
 */
export class GateSupport {
  private settingsCache = new Map<string, { at: number; value: GateSettings }>();

  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'gateRepository'
      | 'warehousesService'
      | 'stockSettings'
      | 'stockService'
      | 'auditService'
      | 'redis'
    >,
  ) {}

  /** The warehouse if the caller holds `key` there (404 outside scope, 403 without the key). */
  warehouse(caller: Caller, warehouseId: string, key: string): Promise<WarehouseRecord> {
    return this.deps.warehousesService.requireVisible(caller, warehouseId, key);
  }

  /** Effective gate settings of a warehouse (15 s cache). */
  async settings(warehouseId: string): Promise<GateSettings> {
    const hit = this.settingsCache.get(warehouseId);
    if (hit !== undefined && Date.now() - hit.at < KEY_SETTINGS_TTL) return hit.value;
    const raw = await this.deps.stockSettings.raw(GATE_SETTING_KEYS, warehouseId);
    const value = { ...GATE_DEFAULTS } as Record<string, unknown>;
    for (const k of GATE_SETTING_KEYS) {
      const v = raw.get(k);
      if (v === undefined || v === null) continue;
      const def = GATE_DEFAULTS[k];
      // Per-purpose maps merge over the defaults (a partial override keeps the other purposes).
      value[k] =
        typeof def === 'object' && !Array.isArray(def) && typeof v === 'object'
          ? { ...(def as object), ...v }
          : v;
    }
    const s = value as unknown as GateSettings;
    this.settingsCache.set(warehouseId, { at: Date.now(), value: s });
    return s;
  }

  invalidateSettings(warehouseId?: string): void {
    if (warehouseId === undefined) this.settingsCache.clear();
    else this.settingsCache.delete(warehouseId);
  }

  async saveSetting(
    tx: Tx,
    key: keyof GateSettings,
    value: unknown,
    userId: string,
    scope: string,
  ) {
    await this.deps.stockSettings.setRaw(tx, key, value, userId, scope);
  }

  nextNo(tx: Tx, kind: DocKind): Promise<string> {
    return this.deps.stockService.nextDocNo(tx, kind);
  }

  /** Local "today" of a warehouse: YYYY-MM-DD + its UTC bounds. */
  today(w: Pick<WarehouseRecord, 'timezone'>, now = new Date()) {
    const date = localDate(now, w.timezone);
    return { date, ...dayBounds(date, w.timezone) };
  }

  /** Timeline row (ids / codes only). */
  async event(
    tx: Tx,
    e: {
      warehouseId: string;
      shipmentId: string;
      gateEntryId?: string | null;
      type: string;
      byUserId: string | null;
      data?: Record<string, unknown>;
      at?: Date;
    },
  ): Promise<void> {
    await this.deps.gateRepository.addEvent(tx, {
      warehouseId: e.warehouseId,
      shipmentId: e.shipmentId,
      gateEntryId: e.gateEntryId ?? null,
      type: e.type,
      byUserId: e.byUserId,
      data: (e.data ?? {}) as object,
      ...(e.at === undefined ? {} : { at: e.at }),
    });
  }

  /** Audit row with driver / visitor PII masked BEFORE writing (audit rows are never purged). */
  audit(
    tx: Tx,
    caller: Caller | null,
    action: string,
    targetType: AuditTarget,
    targetId: string,
    after: object | null = null,
    before: object | null = null,
    reason: string | null = null,
  ): Promise<void> {
    return this.deps.auditService.record(tx, actorOf(caller), {
      action,
      targetType,
      targetId,
      after: after === null ? null : sanitizeAudit(after),
      before: before === null ? null : sanitizeAudit(before),
      reason,
    });
  }

  /** After commit: bumps the warehouse's gate cache version (best effort). */
  bump(warehouseId: string): Promise<void> {
    return bumpGateVersion(this.deps.redis, warehouseId);
  }

  /**
   * Mirrors an entry's status on its shipment (dashboard reads one table) and writes the outbox
   * status event. At EXITED the shipment becomes COMPLETED, or EXPECTED / CANCELLED for a
   * turned-away truck (its pending shipment action).
   */
  async syncEntry(
    tx: Tx,
    entry: EntryRow,
    previous: EntryStatus | null,
    shipment?: ShipmentRow | null,
  ): Promise<void> {
    const action = entry.pendingShipmentAction;
    const stage = stageOf(entry.status, entry.outcome, action);
    const closed = entry.status === 'EXITED' || entry.status === 'CANCELLED';
    const s = shipment ?? (await this.deps.gateRepository.shipment(entry.shipmentId, tx));
    if (s === null) throw new Error('gate entry without shipment');
    const reexpect =
      entry.status === 'EXITED' && entry.outcome === 'REJECTED' && action !== 'CANCEL';
    await this.deps.gateRepository.updateShipment(tx, entry.shipmentId, {
      stage,
      activeEntryId: closed ? null : entry.id,
      vehicleRegNo: closed ? s.plannedVehicleRegNo : entry.vehicleRegNo,
      ...(reexpect ? { rebookingRequired: true, attemptNo: { increment: 1 } } : {}),
      ...(entry.status === 'EXITED' && entry.outcome === 'REJECTED' && action === 'CANCEL'
        ? { cancelledAt: new Date(), cancelReason: entry.rejectionReason ?? 'Turned away' }
        : {}),
    });
    await emitWarehouseEvent(
      tx,
      'gate_entry.status_changed.v1',
      {
        gateEntryId: entry.id,
        entryNo: entry.entryNo,
        shipmentId: s.id,
        shipmentNo: s.shipmentNo,
        warehouseId: entry.warehouseId,
        vendorId: s.vendorId,
        restockRequestId: s.restockRequestId,
        vehicleRegNo: entry.vehicleRegNo,
        status: entry.status,
        previousStatus: previous,
        outcome: entry.outcome,
        netKg: entry.netKg === null ? null : num(entry.netKg).toFixed(2),
        varianceKg: entry.varianceKg === null ? null : num(entry.varianceKg).toFixed(2),
        debitNoteRequired: entry.debitNoteRequired,
        noReceipt: entry.noReceipt,
        at: new Date().toISOString(),
      },
      `gate:${entry.id}:${entry.status}:${String(entry.version)}`,
    );
  }
}
