import { NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import { num } from '../../middleware/http.js';
import { type Paging, decodeCursor, toPageResult } from '../../middleware/paging.js';
import { dayBounds, localTime } from '../../middleware/time.js';
import { isOverlapViolation } from '../docks/index.js';
import type { WarehouseRecord } from '../warehouses/index.js';
import type { AsnRow } from './gate.registers.repository.js';
import { formatRegNo, normalizeRegNo } from './gate.rules.js';
import { conflict, isDuplicate } from './gate.support.js';

export interface AsnInput {
  warehouseId: string;
  vendorId: string;
  vendorAsnRef: string;
  restockRequestId?: string | null;
  vehicleRegNo?: string | null;
  etaAt: string;
  declaredNetKg?: number | null;
  notes?: string | null;
  lines: { variantId: string; qty: number; declaredNetKg?: number | null }[];
}

export interface ConvertInput {
  lines?: { lineNo: number; qty: number }[];
  vehicleRegNo?: string | null;
  transportType?: string;
  etaAt?: string;
  dockDoorId?: string | null;
  plannedDriverName?: string | null;
  plannedDriverMobile?: string | null;
}

interface MatchIssue {
  code: 'VENDOR_MISMATCH' | 'SKU_NOT_ON_PO' | 'OVER_PO_QTY' | 'PO_NOT_OPEN' | 'NO_PO';
  message: string;
  variantId?: string;
}

const STATUS_LABEL: Record<string, string> = {
  RECEIVED: 'Received',
  PENDING: 'Pending',
  MATCHED: 'Matched',
  UNMATCHED: 'Unmatched',
  PARTIALLY_CONVERTED: 'Partly converted',
  CONVERTED: 'Converted',
  CANCELLED: 'Cancelled',
};
const ACTION: Record<string, string> = {
  RECEIVED: 'MATCH_PO',
  PENDING: 'REVIEW',
  MATCHED: 'REVIEW',
  UNMATCHED: 'MATCH_PO',
  PARTIALLY_CONVERTED: 'SHIPMENT',
  CONVERTED: 'SHIPMENT',
  CANCELLED: 'VIEW',
};

/**
 * Vendor ASN (W5.12, D-62): staff entry now, vendor portal / EDI later (internal API, idempotent
 * on vendor + ASN ref). Matching locks the PO (approved procurement request) and checks vendor,
 * SKUs and the open quantity; conversion locks the ASN and turns all or part of it into one
 * inbound shipment per truck (split consignments).
 */
export class GateAsnService {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'gateRegistersRepository'
      | 'gateSupport'
      | 'gateShipments'
      | 'stockService'
      | 'restockService'
      | 'runInTransaction'
    >,
  ) {}

  private get repo() {
    return this.deps.gateRegistersRepository;
  }
  private get support() {
    return this.deps.gateSupport;
  }

  private view(a: AsnRow, w: Pick<WarehouseRecord, 'timezone'>) {
    const expectedUnits = a.lines.reduce((n, l) => n + l.qty, 0);
    const converted = a.lines.reduce((n, l) => n + l.convertedQty, 0);
    const issues = (a.matchIssues ?? []) as unknown as MatchIssue[];
    return {
      id: a.id,
      asnRef: a.vendorAsnRef,
      warehouseId: a.warehouseId,
      vendor: { id: a.vendorId, name: a.vendorName },
      restockRequestId: a.restockRequestId,
      poRef: a.restockRequestNo,
      vehicleRegNo: a.vehicleRegNo,
      vehicleDisplay: a.vehicleRegNo === null ? null : formatRegNo(a.vehicleRegNo),
      etaAt: a.etaAt.toISOString(),
      arrivalWindow: `${a.etaAt.toISOString().slice(0, 10)} · ${localTime(a.etaAt, w.timezone)}`,
      expectedUnits,
      convertedUnits: converted,
      declaredNetKg: a.declaredNetKg === null ? null : num(a.declaredNetKg),
      dockBookingId: a.dockBookingId,
      status: a.status,
      statusLabel: STATUS_LABEL[a.status] ?? a.status,
      action: ACTION[a.status] ?? 'VIEW',
      source: a.source,
      notes: a.notes,
      matchIssues: issues,
      matchBanner:
        a.status === 'MATCHED' || a.status === 'PARTIALLY_CONVERTED' || a.status === 'CONVERTED'
          ? {
              tone: 'success',
              title: 'PO match successful',
              text: 'Confirm quantities, vehicle and applicable documents before creating shipment.',
            }
          : a.status === 'UNMATCHED'
            ? {
                tone: 'danger',
                title: 'PO match failed',
                text: issues.map((i) => i.message).join(' · '),
              }
            : {
                tone: 'warning',
                title: 'Not matched yet',
                text: 'Link the purchase order to validate this ASN.',
              },
      lines: a.lines.map((l) => ({
        lineNo: l.lineNo,
        variantId: l.variantId,
        sku: l.sku,
        name: l.name,
        packLabel: l.packLabel,
        qty: l.qty,
        convertedQty: l.convertedQty,
        remainingQty: l.qty - l.convertedQty,
        declaredNetKg: l.declaredNetKg === null ? null : num(l.declaredNetKg),
      })),
      version: a.version,
      createdAt: a.createdAt.toISOString(),
    };
  }

  async summary(caller: Caller, warehouseId: string, date?: string) {
    const w = await this.support.warehouse(caller, warehouseId, 'gate.view');
    const d = date ?? this.support.today(w).date;
    const b = dayBounds(d, w.timezone);
    const m = await this.repo.asnCounts(w.id, b.from, b.to);
    const n = (...s: string[]) => s.reduce((x, k) => x + (m.get(k) ?? 0), 0);
    return {
      date: d,
      received: { value: n(...Object.keys(STATUS_LABEL)), caption: 'Today' },
      matched: { value: n('MATCHED'), caption: 'PO validated' },
      unmatched: { value: n('UNMATCHED', 'PENDING', 'RECEIVED'), caption: 'Review required' },
      converted: { value: n('CONVERTED', 'PARTIALLY_CONVERTED'), caption: 'Shipment created' },
    };
  }

  async list(
    caller: Caller,
    q: { warehouseId: string; status?: string; q?: string; from?: string; to?: string },
    p: Paging,
  ) {
    const w = await this.support.warehouse(caller, q.warehouseId, 'gate.view');
    const c = decodeCursor(p.cursor);
    const after = c === null ? null : { at: new Date(String(c[0])), id: String(c[1]) };
    const rows = await this.repo.listAsns(
      {
        warehouseId: w.id,
        ...(q.status === undefined ? {} : { status: q.status }),
        ...(q.q === undefined ? {} : { q: q.q }),
        ...(q.from === undefined ? {} : { from: dayBounds(q.from, w.timezone).from }),
        ...(q.to === undefined ? {} : { to: dayBounds(q.to, w.timezone).to }),
      },
      after,
      p.limit,
    );
    const page = toPageResult(rows, p, (r) => [r.createdAt.toISOString(), r.id]);
    return { ...page, items: page.items.map((a) => this.view(a, w)) };
  }

  async get(caller: Caller, id: string) {
    const a = await this.repo.asn(id);
    if (a === null) throw new NotFoundError('ASN');
    const w = await this.support.warehouse(caller, a.warehouseId, 'gate.view');
    return this.view(a, w);
  }

  /**
   * Match against the PO in the caller's transaction (PO row FOR UPDATE): vendor, SKUs and open
   * quantity (other shipments / ASNs excluded from this ASN's own qty).
   */
  private async matchInTx(
    tx: Tx,
    a: AsnRow,
    restockRequestId: string,
  ): Promise<{ issues: MatchIssue[]; poNo: string | null }> {
    const po = await this.deps.restockService.lockProcurement(tx, restockRequestId);
    if (po?.type !== 'PROCUREMENT' || po.destWarehouseId !== a.warehouseId)
      throw new ValidationError([
        {
          path: 'body.restockRequestId',
          message: 'is not a procurement request (PO) of this warehouse',
        },
      ]);
    const issues: MatchIssue[] = [];
    if (po.status !== 'APPROVED' && po.status !== 'PARTIALLY_RECEIVED')
      issues.push({ code: 'PO_NOT_OPEN', message: `${po.requestNo} is not approved / open` });
    if (po.vendorId !== null && po.vendorId !== a.vendorId)
      issues.push({ code: 'VENDOR_MISMATCH', message: 'The PO belongs to another vendor' });
    const remaining = await this.deps.gateShipments.poRemaining(tx, po, { asnId: a.id });
    const want = new Map<string, number>();
    for (const l of a.lines)
      want.set(l.variantId, (want.get(l.variantId) ?? 0) + l.qty - l.convertedQty);
    for (const [variantId, qty] of want) {
      const r = remaining.get(variantId);
      const name = a.lines.find((l) => l.variantId === variantId)?.sku ?? variantId;
      if (r === undefined)
        issues.push({
          code: 'SKU_NOT_ON_PO',
          variantId,
          message: `${name} is not on ${po.requestNo}`,
        });
      else if (qty > r.remaining)
        issues.push({
          code: 'OVER_PO_QTY',
          variantId,
          message: `${name}: ${String(qty)} exceeds the open ${String(r.remaining)}`,
        });
    }
    return { issues, poNo: po.requestNo };
  }

  private async createInternal(
    caller: Caller | null,
    w: WarehouseRecord,
    input: AsnInput,
    source: 'STAFF' | 'VENDOR_API',
  ) {
    const vendor = (await this.deps.stockService.vendorFacts([input.vendorId]))[0];
    if (vendor === undefined)
      throw new ValidationError([{ path: 'body.vendorId', message: 'unknown vendor' }]);
    const variants = new Map(
      (await this.deps.stockService.ensureVariants(input.lines.map((l) => l.variantId))).map(
        (v) => [v.variantId, v],
      ),
    );
    const bad = input.lines.flatMap((l, i) =>
      variants.get(l.variantId)?.isActive === true
        ? []
        : [{ path: `body.lines.${String(i)}.variantId`, message: 'unknown or inactive SKU' }],
    );
    if (bad.length > 0) throw new ValidationError(bad);
    const userId = caller?.userId ?? null;
    try {
      const id = await this.deps.runInTransaction(async (tx) => {
        const a = await this.repo.createAsn(tx, {
          vendorAsnRef: input.vendorAsnRef.trim().toUpperCase(),
          warehouseId: w.id,
          vendorId: vendor.id,
          vendorName: vendor.name,
          vehicleRegNo:
            (input.vehicleRegNo ?? null) === null ? null : normalizeRegNo(input.vehicleRegNo ?? ''),
          etaAt: new Date(input.etaAt),
          expectedUnits: input.lines.reduce((n, l) => n + l.qty, 0),
          declaredNetKg:
            input.declaredNetKg ??
            (input.lines.every((l) => (variants.get(l.variantId)?.weightGrams ?? null) !== null)
              ? Math.round(
                  input.lines.reduce(
                    (n, l) => n + l.qty * (variants.get(l.variantId)?.weightGrams ?? 0),
                    0,
                  ) / 10,
                ) / 100
              : null),
          source,
          notes: input.notes ?? null,
          createdBy: userId,
          status: 'RECEIVED',
          lines: {
            create: input.lines.map((l, i) => ({
              lineNo: i + 1,
              variantId: l.variantId,
              sku: variants.get(l.variantId)?.sku ?? null,
              name: variants.get(l.variantId)?.name ?? null,
              packLabel: variants.get(l.variantId)?.packLabel ?? null,
              qty: l.qty,
              declaredNetKg: l.declaredNetKg ?? null,
            })),
          },
        });
        if ((input.restockRequestId ?? null) !== null) {
          const m = await this.matchInTx(tx, a, input.restockRequestId ?? '');
          await this.repo.updateAsn(tx, a.id, {
            restockRequestId: input.restockRequestId,
            restockRequestNo: m.poNo,
            status: m.issues.length === 0 ? 'MATCHED' : 'UNMATCHED',
            matchIssues: m.issues as unknown as object,
          });
        }
        await this.support.audit(tx, caller, 'gate.asn_received', 'asn', a.id, {
          vendorAsnRef: a.vendorAsnRef,
          vendorId: vendor.id,
          source,
          lines: input.lines.length,
        });
        return a.id;
      });
      await this.support.bump(w.id);
      const a = await this.repo.asn(id);
      if (a === null) throw new NotFoundError('ASN');
      return this.view(a, w);
    } catch (error) {
      if (isDuplicate(error)) {
        const prev = await this.repo.asnByRef(vendor.id, input.vendorAsnRef.trim().toUpperCase());
        if (prev !== null && source === 'VENDOR_API') return this.view(prev, w);
        throw conflict('DUPLICATE_ASN', `ASN ${input.vendorAsnRef} of this vendor already exists`, {
          id: prev?.id ?? null,
        });
      }
      throw error;
    }
  }

  async create(caller: Caller, input: AsnInput) {
    const w = await this.support.warehouse(caller, input.warehouseId, 'gate.operate');
    return this.createInternal(caller, w, input, 'STAFF');
  }

  /** Vendor portal / EDI (service token): idempotent on (vendor, ASN ref). */
  async createFromVendor(input: AsnInput, w: WarehouseRecord) {
    return this.createInternal(null, w, input, 'VENDOR_API');
  }

  async match(caller: Caller, id: string, restockRequestId: string) {
    const a0 = await this.repo.asn(id);
    if (a0 === null) throw new NotFoundError('ASN');
    const w = await this.support.warehouse(caller, a0.warehouseId, 'gate.operate');
    await this.deps.runInTransaction(async (tx) => {
      const a = await this.repo.lockAsn(tx, id);
      if (a === null) throw new NotFoundError('ASN');
      if (!['RECEIVED', 'PENDING', 'MATCHED', 'UNMATCHED'].includes(a.status))
        throw conflict('STALE_STATE', `The ASN is ${a.status.toLowerCase()}`, { status: a.status });
      const m = await this.matchInTx(tx, a, restockRequestId);
      await this.repo.updateAsn(tx, id, {
        restockRequestId,
        restockRequestNo: m.poNo,
        status: m.issues.length === 0 ? 'MATCHED' : 'UNMATCHED',
        matchIssues: m.issues as unknown as object,
      });
      await this.support.audit(tx, caller, 'gate.asn_matched', 'asn', id, {
        restockRequestId,
        result: m.issues.length === 0 ? 'MATCHED' : 'UNMATCHED',
        issues: m.issues.length,
      });
    });
    await this.support.bump(w.id);
    return this.get(caller, id);
  }

  /**
   * ASN (all or some lines) → one inbound shipment, one transaction: ASN FOR UPDATE, converted
   * qty incremented FIRST, then the shipment is created with the PO locked and re-checked.
   */
  async convert(caller: Caller, id: string, input: ConvertInput) {
    const a0 = await this.repo.asn(id);
    if (a0 === null) throw new NotFoundError('ASN');
    const w = await this.support.warehouse(caller, a0.warehouseId, 'gate.operate');
    const pick =
      input.lines ??
      a0.lines
        .filter((l) => l.qty > l.convertedQty)
        .map((l) => ({ lineNo: l.lineNo, qty: l.qty - l.convertedQty }));
    if (pick.length === 0)
      throw conflict('NOTHING_TO_CONVERT', 'Every ASN line is already converted');
    const shipmentInput = {
      warehouseId: w.id,
      purpose: 'INBOUND_CONSIGNMENT' as const,
      vendorId: a0.vendorId,
      restockRequestId: a0.restockRequestId,
      transportType: input.transportType ?? 'TRUCK',
      etaAt: input.etaAt ?? a0.etaAt.toISOString(),
      plannedVehicleRegNo: input.vehicleRegNo ?? a0.vehicleRegNo,
      plannedDriverName: input.plannedDriverName ?? null,
      plannedDriverMobile: input.plannedDriverMobile ?? null,
      dockDoorId: input.dockDoorId ?? null,
      vendorPoNo: null,
      notes: `From ASN ${a0.vendorAsnRef}`,
      lines: pick.map((p) => {
        const l = a0.lines.find((x) => x.lineNo === p.lineNo);
        if (l === undefined)
          throw new ValidationError([
            { path: 'body.lines', message: `ASN line ${String(p.lineNo)} does not exist` },
          ]);
        return { variantId: l.variantId, expectedQty: p.qty };
      }),
    };
    const prep = await this.deps.gateShipments.prepare(caller, w, shipmentInput);
    let shipmentId: string;
    try {
      shipmentId = await this.deps.runInTransaction(async (tx) => {
        const a = await this.repo.lockAsn(tx, id);
        if (a === null) throw new NotFoundError('ASN');
        if (a.status !== 'MATCHED' && a.status !== 'PARTIALLY_CONVERTED')
          throw conflict('ASN_NOT_MATCHED', 'Match the ASN to its purchase order first', {
            status: a.status,
          });
        for (const p of pick) {
          const l = a.lines.find((x) => x.lineNo === p.lineNo);
          if (l === undefined || p.qty > l.qty - l.convertedQty)
            throw conflict(
              'OVER_ASN_QTY',
              `ASN line ${String(p.lineNo)} has only ${String((l?.qty ?? 0) - (l?.convertedQty ?? 0))} left`,
            );
          await this.repo.addConverted(tx, id, p.lineNo, p.qty);
        }
        const sid = await this.deps.gateShipments.createInTx(tx, caller, w, shipmentInput, prep, {
          asnId: id,
        });
        const after = await this.repo.asn(id, tx);
        const done = (after?.lines ?? []).every((l) => l.convertedQty >= l.qty);
        await this.repo.updateAsn(tx, id, { status: done ? 'CONVERTED' : 'PARTIALLY_CONVERTED' });
        await this.support.audit(tx, caller, 'gate.asn_converted', 'asn', id, {
          shipmentId: sid,
          lines: pick,
          status: done ? 'CONVERTED' : 'PARTIALLY_CONVERTED',
        });
        return sid;
      });
    } catch (error) {
      if (isOverlapViolation(error))
        throw conflict('DOCK_BUSY', 'The dock door is booked for that time');
      throw error;
    }
    await this.support.bump(w.id);
    return {
      asn: await this.get(caller, id),
      shipment: await this.deps.gateShipments.view(caller, shipmentId),
    };
  }
}
