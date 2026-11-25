import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from '../../adapters/uuid.js';
import type { Caller } from '../../middleware/guards.js';
import { num } from '../../middleware/http.js';
import { isOverlapViolation } from '../docks/index.js';
import type { WarehouseRecord } from '../warehouses/index.js';
import type { ShipmentRow } from './gate.repository.js';
import {
  DOC_LABEL,
  type DocType,
  type Purpose,
  checklist,
  expectedLoad,
  normalizeRegNo,
} from './gate.rules.js';
import { conflict, isDuplicate } from './gate.support.js';
import {
  PURPOSE_LABEL,
  VEHICLE_TYPE_LABEL,
  docView,
  manifestOf,
  shipmentView,
} from './gate.views.js';

export interface ShipmentLineInput {
  variantId: string;
  expectedQty: number;
}

export interface DocumentInput {
  docType: DocType;
  receipt?: string | null;
  refNo?: string | null;
  validUntil?: string | null;
  note?: string | null;
}

export interface ShipmentInput {
  warehouseId: string;
  purpose?: Purpose;
  vendorId?: string | null;
  restockRequestId?: string | null;
  vendorPoNo?: string | null;
  transferId?: string | null;
  sourceLocation?: string | null;
  transportType: string;
  etaAt: string;
  plannedVehicleRegNo?: string | null;
  plannedDriverName?: string | null;
  plannedDriverMobile?: string | null;
  dockDoorId?: string | null;
  invoiceNetKg?: number | null;
  invoiceGrossKg?: number | null;
  palletCount?: number | null;
  notes?: string | null;
  lines: ShipmentLineInput[];
  documents?: DocumentInput[];
}

export type ShipmentUpdate = Partial<Omit<ShipmentInput, 'warehouseId' | 'documents'>> & {
  expectedVersion: number;
};

const dockBusy = () => conflict('DOCK_BUSY', 'The dock door is booked for that time');
const OPEN_PO = ['APPROVED', 'PARTIALLY_RECEIVED'];

/** One PO line's open quantity (approved − received − open on the gate). */
export interface PoLineQty {
  variantId: string;
  approved: number;
  received: number;
  openOnGate: number;
  remaining: number;
}

/**
 * Inbound shipments (W5.02–W5.04, D-62): wizard preview / create / edit / cancel, its documents
 * and the gate's PO view (an approved PROCUREMENT restock request). Every quantity check against
 * a PO runs with the PO row locked FOR UPDATE.
 */
export class GateShipmentsService {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'gateRepository'
      | 'gateRegistersRepository'
      | 'gateSupport'
      | 'stockService'
      | 'restockService'
      | 'docksService'
      | 'mediaClient'
      | 'runInTransaction'
    >,
  ) {}

  private get repo() {
    return this.deps.gateRepository;
  }
  private get support() {
    return this.deps.gateSupport;
  }

  // ── lookups ──

  async lookups(caller: Caller, warehouseId: string) {
    await this.support.warehouse(caller, warehouseId, 'gate.view');
    const s = await this.support.settings(warehouseId);
    return {
      vehicleTypes: Object.entries(VEHICLE_TYPE_LABEL).map(([value, label]) => ({ value, label })),
      purposes: Object.entries(PURPOSE_LABEL).map(([value, label]) => ({ value, label })),
      docTypes: Object.entries(DOC_LABEL).map(([value, label]) => ({ value, label })),
      requiredDocs: s['gate.requiredDocs'],
      blockReasons: [
        { value: 'MISSING_DOCUMENT', label: 'Missing transport document' },
        { value: 'INVALID_DOCUMENT', label: 'Missing or invalid transport document' },
        { value: 'EWAY_BILL_EXPIRED', label: 'E-way bill expired' },
        { value: 'VEHICLE_MISMATCH', label: 'Vehicle does not match the shipment' },
        { value: 'DRIVER_UNVERIFIED', label: 'Driver identity not verified' },
        { value: 'SECURITY_CONCERN', label: 'Security concern' },
        { value: 'OTHER', label: 'Other' },
      ],
      holdLocations: ['Security holding area', 'Yard parking', 'Outside gate'],
      holdResolutions: [
        { value: 'ACCEPT_VARIANCE', label: 'Accept variance' },
        { value: 'REWEIGH', label: 'Re-weigh' },
        { value: 'ACCEPT_WITH_DEBIT_NOTE', label: 'Accept with debit note' },
      ],
      visitorPurposes: [
        'Vehicle delivery',
        'Vendor meeting',
        'Maintenance',
        'Audit / inspection',
        'Interview',
        'Other',
      ],
      tolerance: s['gate.weightTolerance'],
      packagingAllowance: s['gate.packagingAllowance'],
      slotMinutes: s['gate.slotMinutes'],
      upload: {
        purpose: 'gate_document',
        maxBytes: 25 * 1024 * 1024,
        types: ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff'],
      },
    };
  }

  async bays(caller: Caller, warehouseId: string) {
    await this.support.warehouse(caller, warehouseId, 'gate.view');
    const [doors, inUse] = await Promise.all([
      this.deps.docksService.inboundDoors(warehouseId),
      this.deps.docksService.inUseNow(warehouseId),
    ]);
    return doors.map((d) => {
      const busy = inUse.find((b) => b.dockDoorId === d.id);
      return {
        id: d.id,
        code: d.code,
        name: d.name,
        type: d.type,
        vehicleClass: d.vehicleClass,
        equipment: d.equipment,
        status: busy === undefined ? 'AVAILABLE' : 'BUSY',
        currentRef: busy?.refNo ?? null,
      };
    });
  }

  async products(caller: Caller, warehouseId: string, q: string, limit: number) {
    await this.support.warehouse(caller, warehouseId, 'gate.view');
    const rows = await this.deps.stockService.searchVariants(q, limit);
    return rows
      .filter((v) => v.isActive)
      .map((v) => ({
        variantId: v.variantId,
        sku: v.sku,
        name: v.name,
        variantName: v.variantName,
        brandName: v.brandName,
        packLabel: v.packLabel,
        unitWeightKg: v.weightGrams === null ? null : v.weightGrams / 1000,
        imageUrl: v.imageUrl,
      }));
  }

  // ── PO (approved procurement request) ──

  /** Remaining qty per SKU of a PO (approved − received − open shipments − open ASNs). */
  async poRemaining(
    tx: Tx,
    po: {
      id: string;
      lines: {
        variantId: string;
        requestedQty: number;
        approvedQty: number | null;
        receivedQty: number;
      }[];
    },
    exclude: { shipmentId?: string | null; asnId?: string | null } = {},
  ): Promise<Map<string, PoLineQty>> {
    const [ships, asns] = await Promise.all([
      this.repo.openShipmentQty(tx, po.id, exclude.shipmentId ?? null),
      this.deps.gateRegistersRepository.openAsnQty(tx, po.id, exclude.asnId ?? null),
    ]);
    return new Map(
      po.lines.map((l) => {
        const approved = l.approvedQty ?? l.requestedQty;
        const open = (ships.get(l.variantId) ?? 0) + (asns.get(l.variantId) ?? 0);
        return [
          l.variantId,
          {
            variantId: l.variantId,
            approved,
            received: l.receivedQty,
            openOnGate: open,
            remaining: Math.max(approved - l.receivedQty - open, 0),
          },
        ];
      }),
    );
  }

  /**
   * Locks the PO and checks vendor / warehouse / status and every line against the remaining qty.
   * Returns the PO number. 409 OVER_PO_QTY / VENDOR_MISMATCH / SKU_NOT_ON_PO.
   */
  async checkPoLocked(
    tx: Tx,
    restockRequestId: string,
    warehouseId: string,
    vendorId: string | null,
    lines: readonly ShipmentLineInput[],
    exclude: { shipmentId?: string | null; asnId?: string | null } = {},
  ): Promise<string> {
    const po = await this.deps.restockService.lockProcurement(tx, restockRequestId);
    if (po?.type !== 'PROCUREMENT' || po.destWarehouseId !== warehouseId)
      throw new ValidationError([
        {
          path: 'body.restockRequestId',
          message: 'is not a procurement request (PO) of this warehouse',
        },
      ]);
    if (!OPEN_PO.includes(po.status))
      throw conflict('PO_NOT_OPEN', `The purchase order ${po.requestNo} is not approved / open`);
    if (vendorId !== null && po.vendorId !== null && po.vendorId !== vendorId)
      throw conflict('VENDOR_MISMATCH', 'The purchase order belongs to another vendor');
    const remaining = await this.poRemaining(tx, po, exclude);
    const want = new Map<string, number>();
    for (const l of lines) want.set(l.variantId, (want.get(l.variantId) ?? 0) + l.expectedQty);
    const issues: { variantId: string; code: string; requested: number; remaining: number }[] = [];
    for (const [variantId, qty] of want) {
      const r = remaining.get(variantId);
      if (r === undefined)
        issues.push({ variantId, code: 'SKU_NOT_ON_PO', requested: qty, remaining: 0 });
      else if (qty > r.remaining)
        issues.push({ variantId, code: 'OVER_PO_QTY', requested: qty, remaining: r.remaining });
    }
    if (issues.length > 0)
      throw conflict(
        issues[0]?.code ?? 'OVER_PO_QTY',
        `More than the open quantity of ${po.requestNo}`,
        { issues },
      );
    return po.requestNo;
  }

  async purchaseOrders(
    caller: Caller,
    q: { warehouseId: string; vendorId?: string; q?: string; limit: number },
  ) {
    await this.support.warehouse(caller, q.warehouseId, 'gate.view');
    const rows = await this.deps.restockService.openProcurement(q);
    const open = await this.repo.openShipmentQtyMany(rows.map((r) => r.id));
    const ids = [...new Set(rows.flatMap((r) => r.lines.map((l) => l.variantId)))];
    const [variants, vendors] = await Promise.all([
      this.deps.stockService.ensureVariants(ids),
      this.deps.stockService.vendorFacts(
        rows.flatMap((r) => (r.vendorId === null ? [] : [r.vendorId])),
      ),
    ]);
    const v = new Map(variants.map((x) => [x.variantId, x]));
    const vn = new Map(vendors.map((x) => [x.id, x]));
    return rows.map((r) => ({
      id: r.id,
      requestNo: r.requestNo,
      status: r.status,
      vendor:
        r.vendorId === null
          ? null
          : {
              id: r.vendorId,
              code: vn.get(r.vendorId)?.code ?? null,
              name: vn.get(r.vendorId)?.name ?? null,
            },
      requiredBy: r.requiredBy.toISOString().slice(0, 10),
      lines: r.lines.map((l) => {
        const approved = l.approvedQty ?? l.requestedQty;
        const onGate = open.get(r.id)?.get(l.variantId) ?? 0;
        return {
          variantId: l.variantId,
          sku: v.get(l.variantId)?.sku ?? null,
          name: v.get(l.variantId)?.name ?? null,
          packLabel: v.get(l.variantId)?.packLabel ?? null,
          approvedQty: approved,
          receivedQty: l.receivedQty,
          openOnGate: onGate,
          remainingQty: Math.max(approved - l.receivedQty - onGate, 0),
        };
      }),
    }));
  }

  // ── wizard ──

  /** Lines enriched from the product projection + declared weight (null when any weight is unknown). */
  private async enrich(lines: readonly ShipmentLineInput[]) {
    const variants = await this.deps.stockService.ensureVariants(lines.map((l) => l.variantId));
    const v = new Map(variants.map((x) => [x.variantId, x]));
    const issues = lines.flatMap((l, i) =>
      v.get(l.variantId)?.isActive === true
        ? []
        : [{ path: `body.lines.${String(i)}.variantId`, message: 'unknown or inactive SKU' }],
    );
    const rows = lines.map((l, i) => {
      const f = v.get(l.variantId);
      const grams = f?.weightGrams ?? null;
      return {
        lineNo: i + 1,
        variantId: l.variantId,
        sku: f?.sku ?? null,
        name: f?.name ?? null,
        packLabel: f?.packLabel ?? null,
        expectedQty: l.expectedQty,
        unitWeightGrams: grams,
        declaredNetKg: grams === null ? null : Math.round((l.expectedQty * grams) / 10) / 100,
      };
    });
    const units = rows.reduce((n, r) => n + r.expectedQty, 0);
    const complete = rows.every((r) => r.declaredNetKg !== null);
    const declared = complete
      ? Math.round(rows.reduce((n, r) => n + (r.declaredNetKg ?? 0), 0) * 100) / 100
      : null;
    const label = rows
      .map((r) => `${String(r.expectedQty)} ${r.packLabel ?? 'units'}`)
      .join(' · ')
      .slice(0, 80);
    return { rows, issues, units, declared, label };
  }

  /** First unloading door free for [eta, eta + slot) (W5.03 "Allocated Bay"). */
  private async suggestBay(warehouseId: string, eta: Date, slotMinutes: number) {
    const end = new Date(eta.getTime() + slotMinutes * 60_000);
    const [doors, booked] = await Promise.all([
      this.deps.docksService.inboundDoors(warehouseId),
      this.deps.docksService.inboundBookings(
        warehouseId,
        new Date(eta.getTime() - 24 * 3600_000),
        end,
      ),
    ]);
    const busy = (doorId: string) =>
      booked.some(
        (b) =>
          b.dockDoorId === doorId &&
          (b.status === 'PLANNED' || b.status === 'IN_USE') &&
          b.plannedStart < end &&
          b.plannedEnd > eta,
      );
    const free = doors.find((d) => !busy(d.id));
    return free === undefined
      ? null
      : {
          dockDoorId: free.id,
          code: free.code,
          name: free.name,
          slotStart: eta.toISOString(),
          slotEnd: end.toISOString(),
        };
  }

  /** W5.02–W5.04 dry run: totals, expected load, suggested bay, doc checklist, per-step issues. */
  async preview(caller: Caller, input: ShipmentInput) {
    const w = await this.support.warehouse(caller, input.warehouseId, 'gate.operate');
    const s = await this.support.settings(w.id);
    const purpose = input.purpose ?? 'INBOUND_CONSIGNMENT';
    const issues: { step: 'BASIC' | 'ITEMS' | 'REVIEW'; path: string; message: string }[] = [];
    if (purpose === 'INBOUND_CONSIGNMENT' && (input.vendorId ?? null) === null)
      issues.push({
        step: 'BASIC',
        path: 'body.vendorId',
        message: 'is required for an inbound consignment',
      });
    const vendor =
      (input.vendorId ?? null) === null
        ? null
        : ((await this.deps.stockService.vendorFacts([input.vendorId ?? '']))[0] ?? null);
    if ((input.vendorId ?? null) !== null && vendor === null)
      issues.push({ step: 'BASIC', path: 'body.vendorId', message: 'unknown vendor' });
    const eta = new Date(input.etaAt);
    const lines = input.lines.length === 0 ? null : await this.enrich(input.lines);
    for (const i of lines?.issues ?? []) issues.push({ step: 'ITEMS', ...i });
    if (input.lines.length === 0)
      issues.push({ step: 'ITEMS', path: 'body.lines', message: 'add at least one product' });
    let remaining: PoLineQty[] | null = null;
    if ((input.restockRequestId ?? null) !== null) {
      const po = await this.deps.restockService.procurement(input.restockRequestId ?? '');
      if (po?.type !== 'PROCUREMENT' || po.destWarehouseId !== w.id)
        issues.push({
          step: 'BASIC',
          path: 'body.restockRequestId',
          message: 'is not a PO of this warehouse',
        });
      else
        remaining = [
          ...(await this.deps.runInTransaction((tx) => this.poRemaining(tx, po))).values(),
        ];
      for (const [i, l] of input.lines.entries()) {
        const r = remaining?.find((x) => x.variantId === l.variantId);
        if (remaining !== null && r === undefined)
          issues.push({
            step: 'ITEMS',
            path: `body.lines.${String(i)}.variantId`,
            message: 'is not on the purchase order',
          });
        else if (r !== undefined && l.expectedQty > r.remaining)
          issues.push({
            step: 'ITEMS',
            path: `body.lines.${String(i)}.expectedQty`,
            message: `exceeds the open PO quantity (${String(r.remaining)})`,
          });
      }
    }
    const required = s['gate.requiredDocs'][purpose];
    const today = this.support.today(w).date;
    const docs = (input.documents ?? []).map((d) => ({
      docType: d.docType,
      status: 'PENDING' as const,
      required: required.includes(d.docType),
      validUntil: d.validUntil ?? null,
    }));
    const attached = required.filter((t) => docs.some((d) => d.docType === t));
    const expected = expectedLoad({
      invoiceGrossKg: input.invoiceGrossKg ?? null,
      declaredNetKg: lines?.declared ?? null,
      palletCount: input.palletCount ?? null,
      allowance: s['gate.packagingAllowance'][purpose],
    });
    const bay =
      (input.dockDoorId ?? null) === null
        ? await this.suggestBay(w.id, eta, s['gate.slotMinutes'])
        : null;
    return {
      valid: issues.length === 0,
      issues,
      vendor: vendor === null ? null : { id: vendor.id, code: vendor.code, name: vendor.name },
      lines: lines?.rows ?? [],
      totals: {
        totalUnits: lines?.units ?? 0,
        estimatedWeightKg: lines?.declared ?? null,
        estimatedWeightMt:
          lines?.declared == null ? null : `${(lines.declared / 1000).toFixed(2)} MT`,
        payloadLabel: lines?.label ?? '',
      },
      expectedLoad: expected,
      poRemaining: remaining,
      suggestedBay: bay,
      documents: {
        required,
        attached: attached.length,
        requiredCount: required.length,
        label: `${String(attached.length)}/${String(required.length)} attached`,
        missing: required.filter((t) => !attached.includes(t)),
        checklist: checklist(required, docs, today),
      },
    };
  }

  private searchText(s: {
    shipmentNo: string;
    vehicle: string | null;
    vendorName: string | null;
    vendorCode: string | null;
    po: string | null;
    vendorPo: string | null;
  }) {
    return [s.shipmentNo, s.vehicle, s.vendorName, s.vendorCode, s.po, s.vendorPo]
      .filter((x) => x !== null && x !== '')
      .join(' ')
      .toLowerCase()
      .slice(0, 400);
  }

  private verifyDocs(caller: Caller, docs: readonly DocumentInput[]) {
    return docs.map((d, i) => {
      const file =
        d.receipt === undefined || d.receipt === null
          ? null
          : this.deps.mediaClient.verify(
              d.receipt,
              caller.userId,
              `body.documents.${String(i)}.receipt`,
              'gate_document',
            );
      return { ...d, file };
    });
  }

  /** Validation outside the transaction: vendor, product facts, document receipts. */
  async prepare(caller: Caller, w: WarehouseRecord, input: ShipmentInput) {
    const s = await this.support.settings(w.id);
    const purpose = input.purpose ?? 'INBOUND_CONSIGNMENT';
    if (purpose === 'INBOUND_CONSIGNMENT' && (input.vendorId ?? null) === null)
      throw new ValidationError([
        { path: 'body.vendorId', message: 'is required for an inbound consignment' },
      ]);
    const vendor =
      (input.vendorId ?? null) === null
        ? null
        : ((await this.deps.stockService.vendorFacts([input.vendorId ?? '']))[0] ?? null);
    if ((input.vendorId ?? null) !== null && vendor === null)
      throw new ValidationError([{ path: 'body.vendorId', message: 'unknown vendor' }]);
    if (vendor !== null && vendor.status !== 'ACTIVE')
      throw conflict('VENDOR_INACTIVE', 'The vendor is not active');
    const lines = await this.enrich(input.lines);
    if (lines.issues.length > 0) throw new ValidationError(lines.issues);
    const docs = this.verifyDocs(caller, input.documents ?? []);
    return { settings: s, purpose, vendor, lines, docs };
  }

  /**
   * Creates the shipment in the caller's transaction (wizard, ASN convert): PO locked + checked,
   * INB number, optional dock booking, lines, documents, timeline, audit.
   */
  async createInTx(
    tx: Tx,
    caller: Caller,
    w: WarehouseRecord,
    input: ShipmentInput,
    prep: Awaited<ReturnType<GateShipmentsService['prepare']>>,
    o: { idempotencyKey?: string | null; asnId?: string | null } = {},
  ): Promise<string> {
    const { settings: s, purpose, vendor, lines, docs } = prep;
    const required = s['gate.requiredDocs'][purpose];
    const eta = new Date(input.etaAt);
    const regNo =
      (input.plannedVehicleRegNo ?? null) === null
        ? null
        : normalizeRegNo(input.plannedVehicleRegNo ?? '');
    const poNo =
      (input.restockRequestId ?? null) === null
        ? null
        : await this.checkPoLocked(
            tx,
            input.restockRequestId ?? '',
            w.id,
            vendor?.id ?? null,
            input.lines,
          );
    const shipmentNo = await this.support.nextNo(tx, 'INB');
    const shipmentId = uuidv7();
    let booking: { id: string; dockDoorId: string; code: string } | null = null;
    if ((input.dockDoorId ?? null) !== null) {
      const b = await this.deps.docksService.gateBook(tx, w.id, {
        dockDoorId: input.dockDoorId ?? '',
        start: eta,
        end: new Date(eta.getTime() + s['gate.slotMinutes'] * 60_000),
        refNo: shipmentNo,
        loadQty: (lines.declared ?? lines.units) / 1000 || 1,
        inboundShipmentId: shipmentId,
        vendorId: vendor?.id ?? null,
        asnId: o.asnId ?? null,
        userId: caller.userId,
      });
      booking = { id: b.id, dockDoorId: b.dockDoorId, code: b.door.code };
    }
    await this.repo.createShipment(tx, {
      id: shipmentId,
      shipmentNo,
      warehouseId: w.id,
      purpose,
      vendorId: vendor?.id ?? null,
      vendorCode: vendor?.code ?? null,
      vendorName: vendor?.name ?? null,
      restockRequestId: input.restockRequestId ?? null,
      restockRequestNo: poNo,
      vendorPoNo: input.vendorPoNo ?? null,
      transferId: input.transferId ?? null,
      asnId: o.asnId ?? null,
      sourceLocation: input.sourceLocation ?? null,
      transportType: input.transportType as never,
      plannedVehicleRegNo: regNo,
      plannedDriverName: input.plannedDriverName ?? null,
      plannedDriverMobile: input.plannedDriverMobile ?? null,
      vehicleRegNo: regNo,
      etaAt: eta,
      dockDoorId: booking?.dockDoorId ?? null,
      bayCode: booking?.code ?? null,
      dockBookingId: booking?.id ?? null,
      totalUnits: lines.units,
      declaredNetKg: lines.declared,
      invoiceNetKg: input.invoiceNetKg ?? null,
      invoiceGrossKg: input.invoiceGrossKg ?? null,
      palletCount: input.palletCount ?? null,
      payloadLabel: lines.label,
      notes: input.notes ?? null,
      searchText: this.searchText({
        shipmentNo,
        vehicle: regNo,
        vendorName: vendor?.name ?? null,
        vendorCode: vendor?.code ?? null,
        po: poNo,
        vendorPo: input.vendorPoNo ?? null,
      }),
      idempotencyKey: o.idempotencyKey ?? null,
      createdBy: caller.userId,
      updatedBy: caller.userId,
    });
    await this.repo.replaceLines(tx, shipmentId, lines.rows);
    for (const d of docs)
      await this.repo.createDocument(tx, {
        shipmentId,
        warehouseId: w.id,
        docType: d.docType,
        refNo: d.refNo ?? null,
        validUntil:
          d.validUntil === undefined || d.validUntil === null
            ? null
            : new Date(`${d.validUntil}T00:00:00.000Z`),
        mediaKey: d.file?.key ?? null,
        fileName: d.file?.fileName ?? null,
        sizeBytes: d.file?.size ?? null,
        contentType: d.file?.mime ?? null,
        required: required.includes(d.docType),
        note: d.note ?? null,
        uploadedBy: caller.userId,
      });
    await this.support.event(tx, {
      warehouseId: w.id,
      shipmentId,
      type: 'SHIPMENT_CREATED',
      byUserId: caller.userId,
      data: {
        shipmentNo,
        lines: lines.rows.length,
        bay: booking?.code ?? null,
        asnId: o.asnId ?? null,
      },
    });
    if (booking !== null)
      await this.support.event(tx, {
        warehouseId: w.id,
        shipmentId,
        type: 'APPOINTMENT_BOOKED',
        byUserId: caller.userId,
        data: { bay: booking.code, slotStart: eta.toISOString() },
      });
    await this.support.audit(tx, caller, 'gate.shipment_created', 'gate_shipment', shipmentId, {
      shipmentNo,
      vendorId: vendor?.id ?? null,
      restockRequestId: input.restockRequestId ?? null,
      asnId: o.asnId ?? null,
      lines: lines.rows.length,
      documents: docs.length,
    });
    return shipmentId;
  }

  async create(caller: Caller, input: ShipmentInput, idempotencyKey: string | null) {
    const w = await this.support.warehouse(caller, input.warehouseId, 'gate.operate');
    if (idempotencyKey !== null) {
      const hit = await this.repo.shipmentByKey(idempotencyKey);
      if (hit !== null) return this.view(caller, hit.id);
    }
    const prep = await this.prepare(caller, w, input);
    try {
      const id = await this.deps.runInTransaction((tx) =>
        this.createInTx(tx, caller, w, input, prep, { idempotencyKey }),
      );
      await this.support.bump(w.id);
      return await this.view(caller, id);
    } catch (error) {
      if (isOverlapViolation(error)) throw dockBusy();
      if (idempotencyKey !== null && isDuplicate(error)) {
        const hit = await this.repo.shipmentByKey(idempotencyKey);
        if (hit !== null) return this.view(caller, hit.id);
      }
      throw error;
    }
  }

  /** The shipment visible to the caller (404 outside scope). */
  async load(caller: Caller, id: string, key = 'gate.view', tx?: Tx): Promise<ShipmentRow> {
    const s = await this.repo.shipment(id, tx);
    if (s === null) throw new NotFoundError('Inbound shipment');
    await this.support.warehouse(caller, s.warehouseId, key);
    return s;
  }

  async view(caller: Caller, id: string) {
    const s = await this.load(caller, id);
    return { ...shipmentView(s, new Date()), ...manifestOf(s) };
  }

  async lines(caller: Caller, id: string) {
    const s = await this.load(caller, id);
    return { shipmentId: s.id, shipmentNo: s.shipmentNo, ...manifestOf(s) };
  }

  /** Edit while EXPECTED (W5.01 pencil). Line changes re-check the PO under its lock. */
  async update(caller: Caller, id: string, input: ShipmentUpdate) {
    const current = await this.load(caller, id, 'gate.operate');
    const lines = input.lines === undefined ? null : await this.enrich(input.lines);
    if (lines !== null && lines.issues.length > 0) throw new ValidationError(lines.issues);
    const s = await this.support.settings(current.warehouseId);
    try {
      await this.deps.runInTransaction(async (tx) => {
        const row = await this.repo.lockShipment(tx, id);
        if (row === null) throw new NotFoundError('Inbound shipment');
        if (row.version !== input.expectedVersion)
          throw new ConflictError('The shipment was changed by someone else; reload it', {
            details: { reason: 'VERSION_CONFLICT', currentVersion: row.version },
          });
        if (row.stage !== 'EXPECTED')
          throw conflict('STALE_STATE', 'Only an expected shipment can be edited', {
            status: row.stage,
          });
        const poId =
          input.restockRequestId === undefined ? row.restockRequestId : input.restockRequestId;
        let poNo = row.restockRequestNo;
        if (poId !== null && (lines !== null || input.restockRequestId !== undefined))
          poNo = await this.checkPoLocked(
            tx,
            poId,
            row.warehouseId,
            row.vendorId,
            input.lines ?? row.lines,
            { shipmentId: row.id },
          );
        if (poId === null) poNo = null;
        const eta = input.etaAt === undefined ? row.etaAt : new Date(input.etaAt);
        let bay: {
          dockDoorId: string | null;
          bayCode: string | null;
          dockBookingId: string | null;
        } = {
          dockDoorId: row.dockDoorId,
          bayCode: row.bayCode,
          dockBookingId: row.dockBookingId,
        };
        const doorChanged = input.dockDoorId !== undefined && input.dockDoorId !== row.dockDoorId;
        const timeChanged = input.etaAt !== undefined && eta.getTime() !== row.etaAt.getTime();
        if (doorChanged || (timeChanged && row.dockBookingId !== null)) {
          const door = input.dockDoorId === undefined ? row.dockDoorId : input.dockDoorId;
          if (row.dockBookingId !== null && door !== null) {
            const b = await this.deps.docksService.gateReschedule(
              tx,
              row.warehouseId,
              row.dockBookingId,
              {
                dockDoorId: door,
                start: eta,
                end: new Date(eta.getTime() + s['gate.slotMinutes'] * 60_000),
                userId: caller.userId,
              },
            );
            bay = { dockDoorId: b.dockDoorId, bayCode: b.door.code, dockBookingId: b.id };
          } else if (row.dockBookingId !== null && door === null) {
            await this.deps.docksService.gateMove(
              tx,
              row.warehouseId,
              row.dockBookingId,
              'cancel',
              caller.userId,
            );
            bay = { dockDoorId: null, bayCode: null, dockBookingId: null };
          } else if (door !== null) {
            const b = await this.deps.docksService.gateBook(tx, row.warehouseId, {
              dockDoorId: door,
              start: eta,
              end: new Date(eta.getTime() + s['gate.slotMinutes'] * 60_000),
              refNo: row.shipmentNo,
              loadQty: num(row.declaredNetKg) / 1000 || 1,
              inboundShipmentId: row.id,
              vendorId: row.vendorId,
              userId: caller.userId,
            });
            bay = { dockDoorId: b.dockDoorId, bayCode: b.door.code, dockBookingId: b.id };
          }
        }
        const regNo =
          input.plannedVehicleRegNo === undefined
            ? row.plannedVehicleRegNo
            : input.plannedVehicleRegNo === null
              ? null
              : normalizeRegNo(input.plannedVehicleRegNo);
        await this.repo.updateShipment(tx, id, {
          ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
          ...(input.vendorPoNo === undefined ? {} : { vendorPoNo: input.vendorPoNo }),
          ...(input.sourceLocation === undefined ? {} : { sourceLocation: input.sourceLocation }),
          ...(input.transportType === undefined
            ? {}
            : { transportType: input.transportType as never }),
          ...(input.plannedDriverName === undefined
            ? {}
            : { plannedDriverName: input.plannedDriverName }),
          ...(input.plannedDriverMobile === undefined
            ? {}
            : { plannedDriverMobile: input.plannedDriverMobile }),
          ...(input.invoiceNetKg === undefined ? {} : { invoiceNetKg: input.invoiceNetKg }),
          ...(input.invoiceGrossKg === undefined ? {} : { invoiceGrossKg: input.invoiceGrossKg }),
          ...(input.palletCount === undefined ? {} : { palletCount: input.palletCount }),
          ...(input.notes === undefined ? {} : { notes: input.notes }),
          restockRequestId: poId,
          restockRequestNo: poNo,
          plannedVehicleRegNo: regNo,
          vehicleRegNo: regNo,
          etaAt: eta,
          ...bay,
          ...(lines === null
            ? {}
            : {
                totalUnits: lines.units,
                declaredNetKg: lines.declared,
                payloadLabel: lines.label,
              }),
          searchText: this.searchText({
            shipmentNo: row.shipmentNo,
            vehicle: regNo,
            vendorName: row.vendorName,
            vendorCode: row.vendorCode,
            po: poNo,
            vendorPo: input.vendorPoNo === undefined ? row.vendorPoNo : input.vendorPoNo,
          }),
          updatedBy: caller.userId,
        });
        if (lines !== null) await this.repo.replaceLines(tx, id, lines.rows);
        await this.support.event(tx, {
          warehouseId: row.warehouseId,
          shipmentId: id,
          type: timeChanged || doorChanged ? 'APPOINTMENT_RESCHEDULED' : 'SHIPMENT_UPDATED',
          byUserId: caller.userId,
          data: { bay: bay.bayCode, etaAt: eta.toISOString() },
        });
        await this.support.audit(
          tx,
          caller,
          'gate.shipment_updated',
          'gate_shipment',
          id,
          { ...input, lines: input.lines?.length },
          { version: row.version },
        );
      });
    } catch (error) {
      if (isOverlapViolation(error)) throw dockBusy();
      throw error;
    }
    await this.support.bump(current.warehouseId);
    return this.view(caller, id);
  }

  /** Trash icon: soft cancel of an EXPECTED shipment (frees its dock booking). */
  async cancel(caller: Caller, id: string, reason: string) {
    const current = await this.load(caller, id, 'gate.operate');
    await this.deps.runInTransaction(async (tx) => {
      const row = await this.repo.lockShipment(tx, id);
      if (row === null) throw new NotFoundError('Inbound shipment');
      if (row.stage !== 'EXPECTED')
        throw conflict('STALE_STATE', 'Only an expected shipment can be cancelled', {
          status: row.stage,
        });
      if (row.dockBookingId !== null)
        await this.deps.docksService.gateMove(
          tx,
          row.warehouseId,
          row.dockBookingId,
          'cancel',
          caller.userId,
        );
      await this.repo.updateShipment(tx, id, {
        stage: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: reason,
        updatedBy: caller.userId,
      });
      await this.support.event(tx, {
        warehouseId: row.warehouseId,
        shipmentId: id,
        type: 'SHIPMENT_CANCELLED',
        byUserId: caller.userId,
        data: {},
      });
      await this.support.audit(
        tx,
        caller,
        'gate.shipment_cancelled',
        'gate_shipment',
        id,
        { stage: 'CANCELLED' },
        { stage: row.stage },
        reason,
      );
    });
    await this.support.bump(current.warehouseId);
    return this.view(caller, id);
  }

  // ── documents ──

  async attachDocument(caller: Caller, shipmentId: string, input: DocumentInput) {
    const s = await this.load(caller, shipmentId, 'gate.operate');
    const w = await this.support.warehouse(caller, s.warehouseId, 'gate.operate');
    if (s.stage === 'COMPLETED' || s.stage === 'CANCELLED')
      throw conflict('STALE_STATE', 'The shipment is closed', { status: s.stage });
    const [d] = this.verifyDocs(caller, [input]);
    const settings = await this.support.settings(s.warehouseId);
    const required = settings['gate.requiredDocs'][s.purpose].includes(input.docType);
    const doc = await this.deps.runInTransaction(async (tx) => {
      const created = await this.repo.createDocument(tx, {
        shipmentId,
        warehouseId: s.warehouseId,
        gateEntryId: s.activeEntryId,
        docType: input.docType,
        refNo: input.refNo ?? null,
        validUntil:
          input.validUntil === undefined || input.validUntil === null
            ? null
            : new Date(`${input.validUntil}T00:00:00.000Z`),
        mediaKey: d?.file?.key ?? null,
        fileName: d?.file?.fileName ?? null,
        sizeBytes: d?.file?.size ?? null,
        contentType: d?.file?.mime ?? null,
        required,
        note: input.note ?? null,
        uploadedBy: caller.userId,
      });
      await this.support.event(tx, {
        warehouseId: s.warehouseId,
        shipmentId,
        gateEntryId: s.activeEntryId,
        type: 'DOC_ATTACHED',
        byUserId: caller.userId,
        data: { docId: created.id, docType: input.docType },
      });
      await this.support.audit(tx, caller, 'gate.document_attached', 'gate_document', created.id, {
        shipmentId,
        docType: input.docType,
        refNo: input.refNo ?? null,
      });
      return created;
    });
    await this.support.bump(s.warehouseId);
    return docView(doc, this.support.today(w).date);
  }

  async removeDocument(caller: Caller, shipmentId: string, docId: string) {
    const s = await this.load(caller, shipmentId, 'gate.operate');
    await this.deps.runInTransaction(async (tx) => {
      const d = await this.repo.lockDocument(tx, docId);
      if (d?.shipmentId !== shipmentId) throw new NotFoundError('Document');
      if (d.status !== 'PENDING' || d.verifiedAt !== null)
        throw conflict('DOC_VERIFIED', 'A verified document cannot be removed');
      await this.repo.deleteDocument(tx, docId);
      await this.support.audit(tx, caller, 'gate.document_removed', 'gate_document', docId, null, {
        docType: d.docType,
        refNo: d.refNo,
      });
    });
    await this.support.bump(s.warehouseId);
  }

  async previewDocument(caller: Caller, docId: string) {
    const d = await this.repo.document(docId);
    if (d === null) throw new NotFoundError('Document');
    const s = await this.load(caller, d.shipmentId);
    const w = await this.support.warehouse(caller, s.warehouseId, 'gate.view');
    const urls = d.mediaKey === null ? {} : await this.deps.mediaClient.signRead([d.mediaKey]);
    return {
      ...docView(d, this.support.today(w).date),
      shipmentNo: s.shipmentNo,
      vendor: { id: s.vendorId, code: s.vendorCode, name: s.vendorName },
      url: d.mediaKey === null ? null : (urls[d.mediaKey] ?? null),
      urlExpiresInSeconds: d.mediaKey === null ? null : 300,
      statusText:
        d.status === 'VERIFIED'
          ? d.docType === 'PURCHASE_ORDER'
            ? 'Verified against PO'
            : 'Verified'
          : d.status === 'EXEMPTED'
            ? 'Exemption recorded'
            : d.status === 'REJECTED'
              ? 'Rejected'
              : 'Pending verification',
    };
  }
}
