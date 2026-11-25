import { NotFoundError, ServiceUnavailableError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import { num } from '../../middleware/http.js';
import type { WarehouseRecord } from '../warehouses/index.js';
import type { EntryRow, PassRow, ShipmentRow } from './gate.repository.js';
import { type GateSettings, formatRegNo, maskMobile } from './gate.rules.js';
import { renderPassPdf, renderSlipPdf } from './gate.pdf.js';
import { type QrKeys, loadQrKeys, signPass, verifyPass } from './gate.qr.js';
import { conflict, stale } from './gate.support.js';
import { passView } from './gate.views.js';

const passExpired = () => conflict('PASS_EXPIRED', 'The gate pass has expired; reissue it');

/**
 * Gate passes (W5.07 / W5.09c, D-62): inward (GPI) on approval, outward (GPO) before exit.
 * Signed QR (own key set with kid rotation), single-use scan (ISSUED → USED atomically + entry
 * status check), reissue (VOID + new), PDF from the immutable snapshot.
 */
export class GatePassesService {
  private keys: QrKeys | null | undefined;

  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'config'
      | 'gateRepository'
      | 'gateSupport'
      | 'gateEntries'
      | 'gateWeighbridge'
      | 'runInTransaction'
    >,
  ) {}

  private get repo() {
    return this.deps.gateRepository;
  }
  private get support() {
    return this.deps.gateSupport;
  }

  private qrKeys(): QrKeys {
    if (this.keys === undefined) this.keys = loadQrKeys(this.deps.config);
    if (this.keys === null)
      throw new ServiceUnavailableError('Gate pass signing is not configured');
    return this.keys;
  }

  /** The QR token of a live ISSUED pass (null for USED / VOID). */
  private token(p: PassRow): string | null {
    if (p.status !== 'ISSUED') return null;
    return signPass(
      {
        v: 1,
        kid: p.kid,
        passId: p.id,
        passNo: p.passNo,
        entryId: p.gateEntryId,
        wh: p.warehouseId,
        type: p.type,
        exp: Math.floor(p.expiresAt.getTime() / 1000),
      },
      this.qrKeys(),
    );
  }

  private async snapshot(
    tx: Tx,
    e: EntryRow,
    s: ShipmentRow,
    type: 'INWARD' | 'OUTWARD',
    w: WarehouseRecord,
    extra: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const docs = await this.repo.documentsOf(s.id, tx);
    const challan = docs.find((d) => d.docType === 'DELIVERY_CHALLAN' && d.status !== 'REJECTED');
    const base = {
      warehouseId: w.id,
      warehouseName: w.name,
      warehouseCode: w.code,
      entryNo: e.entryNo,
      shipmentNo: s.shipmentNo,
      vehicleDisplay: formatRegNo(e.vehicleRegNo),
      driverName: e.driverName,
      driverMobileMasked: maskMobile(e.driverMobile),
      grossKg: e.grossKg === null ? null : num(e.grossKg),
    };
    if (type === 'INWARD')
      return {
        ...base,
        arrivedAt: e.arrivedAt.toISOString(),
        bayCode: e.bayCode,
        poRef: s.restockRequestNo ?? s.vendorPoNo,
        challanNo: challan?.refNo ?? null,
        declaredKg: s.declaredNetKg === null ? null : num(s.declaredNetKg),
        verifiedByLabel: 'Gate supervisor',
        approvedBy: e.approvedBy,
        receivingStatus: 'Awaiting unload',
        ...extra,
      };
    return {
      ...base,
      rcvNo: e.rcvNo,
      tareKg: e.tareKg === null ? null : num(e.tareKg),
      netKg: e.netKg === null ? null : num(e.netKg),
      outcome: e.outcome ?? 'COMPLETED',
      ...extra,
    };
  }

  /** Issues a pass in the caller's transaction (entry already moved to APPROVED / PASS_OUT). */
  async issueInTx(
    tx: Tx,
    caller: Caller,
    e: EntryRow,
    s: ShipmentRow,
    type: 'INWARD' | 'OUTWARD',
    w: WarehouseRecord,
    settings: GateSettings,
    extra: Record<string, unknown> = {},
    reissueOf: PassRow | null = null,
  ): Promise<PassRow> {
    const keys = this.qrKeys();
    const passNo = await this.support.nextNo(tx, type === 'INWARD' ? 'GPI' : 'GPO');
    const snap =
      reissueOf === null
        ? await this.snapshot(tx, e, s, type, w, extra)
        : { ...(reissueOf.snapshot as Record<string, unknown>), reissueOf: reissueOf.passNo };
    const p = await this.repo.createPass(tx, {
      passNo,
      type,
      gateEntryId: e.id,
      warehouseId: e.warehouseId,
      outcome: type === 'OUTWARD' ? (e.outcome ?? 'COMPLETED') : null,
      kid: keys.activeKid,
      expiresAt: new Date(Date.now() + settings['gate.passValidityHours'] * 3600_000),
      snapshot: snap as object,
      issuedBy: caller.userId,
      reissueOfId: reissueOf?.id ?? null,
    });
    await this.support.event(tx, {
      warehouseId: e.warehouseId,
      shipmentId: e.shipmentId,
      gateEntryId: e.id,
      type:
        reissueOf !== null
          ? 'PASS_REISSUED'
          : type === 'INWARD'
            ? 'PASS_IN_ISSUED'
            : 'PASS_OUT_ISSUED',
      byUserId: caller.userId,
      data: { passNo, ...(reissueOf === null ? {} : { replaces: reissueOf.passNo }) },
    });
    await this.support.audit(tx, caller, 'gate.pass_issued', 'gate_pass', p.id, {
      passNo,
      type,
      entryNo: e.entryNo,
      reissueOf: reissueOf?.passNo ?? null,
    });
    return p;
  }

  /** VOID the live pass of a type (turn-away voids GP-IN; a late override voids GP-OUT). */
  async voidLiveInTx(
    tx: Tx,
    caller: Caller,
    e: EntryRow,
    type: 'INWARD' | 'OUTWARD',
    reason: string,
  ) {
    const live = await this.repo.livePass(tx, e.id, type);
    if (live === null) return;
    if (await this.repo.voidPass(tx, live.id, ['ISSUED', 'USED'], reason))
      await this.support.audit(
        tx,
        caller,
        'gate.pass_voided',
        'gate_pass',
        live.id,
        { passNo: live.passNo, status: 'VOID' },
        { status: live.status },
        reason,
      );
  }

  /** Marks the live pass USED (handover / exit by button); a missing pass is not an error. */
  async useLiveInTx(tx: Tx, caller: Caller, e: EntryRow, type: 'INWARD' | 'OUTWARD') {
    const live = await this.repo.livePass(tx, e.id, type);
    if (live !== null && live.status === 'ISSUED')
      await this.repo.usePass(tx, live.id, caller.userId);
  }

  async forEntry(entryId: string) {
    const rows = await this.repo.passesOf(entryId);
    return rows.map((p) => passView(p, this.token(p)));
  }

  /** W5.07: passes + QR + handover chips. */
  async passes(caller: Caller, entryId: string) {
    const { e } = await this.deps.gateEntries.load(caller, entryId);
    const items = await this.forEntry(entryId);
    const done = (b: boolean) => (b ? 'DONE' : 'PENDING');
    return {
      entryId,
      approved: e.approvedAt !== null,
      banner:
        e.approvedAt === null
          ? null
          : {
              title: 'Gate entry approved',
              text: 'All applicable compliance checks passed. Inward gate pass is ready to issue.',
            },
      items,
      chips: [
        { key: 'GATE_APPROVED', label: 'Gate approved', state: done(e.approvedAt !== null) },
        {
          key: 'PASS_ISSUED',
          label: 'Pass issued',
          state: done(items.some((p) => p.type === 'INWARD' && p.status !== 'VOID')),
        },
        {
          key: 'RECEIVING',
          label: e.unloadedAt === null ? 'Receiving pending' : 'Receiving done',
          state: done(e.unloadedAt !== null),
        },
        {
          key: 'EXIT_TARE',
          label: e.tareAt === null ? 'Exit tare pending' : 'Exit tare done',
          state: done(e.tareAt !== null),
        },
      ],
    };
  }

  async pdf(caller: Caller, passNo: string): Promise<{ file: Buffer; passNo: string }> {
    const p = await this.repo.passByNo(passNo);
    if (p === null) throw new NotFoundError('Gate pass');
    await this.support.warehouse(caller, p.warehouseId, 'gate.view');
    const file = await renderPassPdf(
      {
        passNo: p.passNo,
        type: p.type,
        status: p.status,
        issuedAt: p.issuedAt,
        expiresAt: p.expiresAt,
      },
      p.snapshot as Record<string, unknown>,
      this.token(p),
    );
    return { file, passNo: p.passNo };
  }

  /**
   * Receiving desk / exit gate scan: HMAC (any configured kid) + expiry, then ISSUED → USED
   * atomically with the entry move (GP-IN → handover, GP-OUT → exit). Replays → 409.
   */
  async scan(caller: Caller, qrToken: string) {
    const v = verifyPass(qrToken, this.qrKeys(), Math.floor(Date.now() / 1000));
    if (!v.ok) {
      if (v.reason === 'EXPIRED') throw passExpired();
      throw conflict('PASS_INVALID', 'This is not a valid FarmX gate pass', { why: v.reason });
    }
    const p = await this.repo.pass(v.claims.passId);
    if (p?.passNo !== v.claims.passNo || p.gateEntryId !== v.claims.entryId)
      throw conflict('PASS_INVALID', 'This is not a valid FarmX gate pass');
    const w = await this.support.warehouse(caller, p.warehouseId, 'gate.operate');
    if (p.status === 'USED')
      throw conflict('PASS_ALREADY_USED', `Pass ${p.passNo} was already used`);
    if (p.status === 'VOID') throw conflict('PASS_VOID', `Pass ${p.passNo} was voided`);
    await this.deps.runInTransaction(async (tx) => {
      const cur = await this.repo.lockEntry(tx, p.gateEntryId);
      if (cur === null) throw new NotFoundError('Gate entry');
      if (!(await this.repo.usePass(tx, p.id, caller.userId)))
        throw conflict('PASS_ALREADY_USED', `Pass ${p.passNo} was already used`);
      if (p.type === 'INWARD') {
        if (cur.status !== 'APPROVED') throw stale(cur.status);
        await this.deps.gateEntries.handoverInTx(tx, caller, cur);
      } else {
        if (cur.status !== 'PASS_OUT') throw stale(cur.status);
        await this.deps.gateWeighbridge.exitInTx(tx, caller, cur, w);
      }
    });
    await this.support.bump(p.warehouseId);
    return {
      passNo: p.passNo,
      type: p.type,
      action: p.type === 'INWARD' ? 'HANDOVER' : 'EXIT',
      entry: await this.deps.gateEntries.out(p.gateEntryId),
    };
  }

  /** Expired / damaged pass: VOID + a new pass (same snapshot), entry state still valid. */
  async reissue(caller: Caller, passNo: string, reason: string) {
    const old = await this.repo.passByNo(passNo);
    if (old === null) throw new NotFoundError('Gate pass');
    const w = await this.support.warehouse(caller, old.warehouseId, 'gate.approve');
    const settings = await this.support.settings(w.id);
    const created = await this.deps.runInTransaction(async (tx) => {
      const cur = await this.repo.lockEntry(tx, old.gateEntryId);
      if (cur === null) throw new NotFoundError('Gate entry');
      const need = old.type === 'INWARD' ? 'APPROVED' : 'PASS_OUT';
      if (cur.status !== need) throw stale(cur.status);
      if (!(await this.repo.voidPass(tx, old.id, ['ISSUED'], `Reissued: ${reason}`)))
        throw conflict('PASS_NOT_ISSUED', `Pass ${old.passNo} is ${old.status.toLowerCase()}`);
      const s = await this.repo.shipment(cur.shipmentId, tx);
      if (s === null) throw new NotFoundError('Inbound shipment');
      const p = await this.issueInTx(tx, caller, cur, s, old.type, w, settings, {}, old);
      await this.repo.setReplacement(tx, old.id, p.id);
      return p;
    });
    await this.support.bump(w.id);
    return passView(created, this.token(created));
  }

  /** W5.09 Print slip / PDF. */
  async slipPdf(caller: Caller, entryId: string): Promise<{ file: Buffer; entryNo: string }> {
    const { e, w } = await this.deps.gateEntries.load(caller, entryId);
    const [rows, scales, s] = await Promise.all([
      this.repo.weighmentsOf(entryId),
      this.repo.scales(w.id),
      this.repo.shipment(e.shipmentId),
    ]);
    const code = new Map(scales.map((x) => [x.id, x.code]));
    const reading = (kind: string) => {
      const r = rows.find((x) => x.kind === kind && x.status === 'ACTIVE');
      return r === undefined
        ? null
        : {
            kg: num(r.weightKg),
            at: r.capturedAt.toISOString(),
            scale: r.scaleId === null ? null : (code.get(r.scaleId) ?? null),
            slipNo: r.slipNo,
          };
    };
    const file = await renderSlipPdf({
      entryNo: e.entryNo,
      shipmentNo: s?.shipmentNo ?? '',
      warehouseName: w.name,
      vehicleDisplay: formatRegNo(e.vehicleRegNo),
      driverName: e.driverName,
      driverVerified: e.driverVerified,
      gross: reading('GROSS'),
      tare: reading('TARE'),
      netKg: e.netKg === null ? null : num(e.netKg),
      varianceKg: e.varianceKg === null ? null : num(e.varianceKg),
      result: e.reconResult,
    });
    return { file, entryNo: e.entryNo };
  }
}
