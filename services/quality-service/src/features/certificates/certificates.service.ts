import { AppError, ErrorCode, NotFoundError } from '@farmx/common/errors';
import type { RunInTransaction, Tx } from '@farmx/database';

import type { MediaClient } from '../../adapters/media-client.js';
import type { UnitTrace, WarehouseClient } from '../../adapters/warehouse-client.js';
import type { Customer } from '../../middleware/guards.js';
import { ymd } from '../../middleware/http.js';
import type { AuditService } from '../audit/index.js';
import type { CoasService } from '../coas/index.js';
import type { LabsService } from '../labs/index.js';
import type { ProjectionsService } from '../projections/index.js';
import type { ReleaseService } from '../release/index.js';
import type { SamplesService } from '../samples/index.js';
import { mismatch, specLabel } from '../specs/index.js';
import type { CertificatesRepository } from './certificates.repository.js';
import type { Card, CardStatus } from './certificates.types.js';

const POLICY =
  'If the independent result fails: the whole consignment is quarantined. You will be told immediately, with return steps. Manufacturer and independent results remain separately labelled.';
const PRIVACY =
  'No buyer or farm details are shown here. Only the goods, batch, source certificate and verdict are public.';
const COLD = new Set(['CC_REF', 'CC_FRZ']);

/** 404 for a code that is not a FarmX unit / consignment (the "Invalid QR" sheet). */
const unverified = () =>
  new AppError(
    ErrorCode.NOT_FOUND,
    'The scanned code does not belong to any FarmX authenticated consignment or certified manufacturer lot',
    404,
    {
      details: {
        reason: 'UNVERIFIED_CODE',
        hint: 'Scan the FarmX QR sticker, not the courier label',
      },
    },
  );

const fmtDay = (d: Date) =>
  d.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });

/** Public allow-list (verify page): NEVER add buyer, farm, order, shipment or delivery fields. */
export const PUBLIC_KEYS = [
  'batchNo',
  'mfgDate',
  'expiryDate',
  'cnNos',
  'product',
  'status',
  'statusText',
  'quarantine',
  'certificates',
  'parameters',
  'whatFailed',
  'mismatch',
] as const;

export const toPublic = (card: Card) =>
  Object.fromEntries(PUBLIC_KEYS.map((k) => [k, card[k]])) as Pick<
    Card,
    (typeof PUBLIC_KEYS)[number]
  >;

/**
 * Customer app certificates (C-24b / C-25b / Lab pending / Certificate Audit Alert / Scan result)
 * and the public verify page (D-60 point 4):
 *  - customer routes only show consignments and units the caller received (buyer projection);
 *  - the public view is an explicit allow-list (goods, batch, certificates, verdict).
 */
export class CertificatesService {
  constructor(
    private readonly deps: {
      certificatesRepository: CertificatesRepository;
      runInTransaction: RunInTransaction;
      auditService: AuditService;
      mediaClient: MediaClient;
      warehouseClient: WarehouseClient;
      projectionsService: ProjectionsService;
      coasService: CoasService;
      samplesService: SamplesService;
      releaseService: ReleaseService;
      labsService: LabsService;
    },
  ) {}

  // ── Customer ──

  /** "Certificates" + "Your orders": batches the caller received, newest first. */
  async list(c: Customer, q: { q?: string; cursor?: string; limit: number }) {
    const { projectionsService } = this.deps;
    const term = q.q?.trim();
    const offset = q.cursor === undefined ? 0 : Math.max(0, Number.parseInt(q.cursor, 10) || 0);
    let filter: { batchIds?: string[]; orderPrefix?: string } = {};
    if (term !== undefined && term !== '') {
      const [byCn, byName] = await Promise.all([
        projectionsService.batchIdsOfCnPrefix(term),
        projectionsService.variantIdsMatching(term, 200),
      ]);
      const byVariant = await projectionsService.batchIdsOfVariants(byName);
      filter = { batchIds: [...new Set([...byCn, ...byVariant])], orderPrefix: term };
    }
    const rows = await projectionsService.customerRows(c.userId, filter, offset, q.limit + 1);
    const page = rows.slice(0, q.limit);
    const cards = await this.cards(
      page.map((r) => r.batchId),
      false,
    );
    return {
      items: page.map((r) => {
        const card = cards.get(r.batchId);
        return {
          batchId: r.batchId,
          batchNo: card?.batchNo ?? null,
          cnNo: card?.cnNos[0] ?? null,
          cnNos: card?.cnNos ?? [],
          product: card?.product ?? null,
          vendorName: card?.vendorName ?? null,
          orderId: r.orderId,
          orderNo: r.orderNo,
          qty: r.qty,
          dispatchedAt: r.dispatchedAt.toISOString(),
          coaCount: card?.certificates.length ?? 0,
          status: card?.status ?? 'NO_CERTIFICATE',
          statusText: card?.statusText ?? null,
        };
      }),
      nextCursor: rows.length > q.limit ? String(offset + q.limit) : null,
      limit: q.limit,
    };
  }

  /** Scan result & journey. Order ref, delivery proof and journey only for the unit's buyer. */
  async unit(c: Customer, qrCode: string) {
    const trace = await this.deps.warehouseClient.unitTrace(qrCode);
    if (trace === null) throw unverified();
    const card = (await this.cards([trace.batchId], true)).get(trace.batchId);
    if (card === undefined) throw unverified();
    const own = trace.shipment !== null && trace.shipment.customerUserId === c.userId;
    const watching = own
      ? (await this.deps.certificatesRepository.watches(c.userId, [trace.batchId])).length > 0
      : false;
    return {
      qrCode: trace.qrCode,
      genuine: true,
      badge: 'Genuine FarmX unit',
      yours: own,
      unit: { seq: trace.seq, of: trace.unitCount },
      sourceCn: trace.receipt?.cnNo ?? card.cnNos[0] ?? null,
      order:
        own && trace.shipment !== null
          ? { orderId: trace.shipment.orderId, orderNo: trace.shipment.orderNo }
          : null,
      journey: this.journey(trace, card, own),
      watching,
      ...card,
    };
  }

  /** C-24b / C-25b / Lab pending / Audit Alert for a consignment the caller received from. */
  async consignment(c: Customer, cnNo: string) {
    const { projectionsService, certificatesRepository } = this.deps;
    const batchIds = await projectionsService.batchIdsOfCn(cnNo);
    const mine =
      batchIds.length === 0 ? [] : await projectionsService.customerRowsIn(c.userId, batchIds);
    if (mine.length === 0) throw new NotFoundError('Consignment');
    const owned = [...new Set(mine.map((m) => m.batchId))];
    const [cards, watches] = await Promise.all([
      this.cards(owned, true),
      certificatesRepository.watches(c.userId, owned),
    ]);
    return {
      cnNo,
      batches: owned.flatMap((b) => {
        const card = cards.get(b);
        return card === undefined
          ? []
          : [{ ...card, watching: watches.some((w) => w.batchId === b) }];
      }),
      yourOrders: [
        ...new Map(
          mine.map((m) => [
            m.orderId,
            { orderId: m.orderId, orderNo: m.orderNo, dispatchedAt: m.dispatchedAt.toISOString() },
          ]),
        ).values(),
      ],
      privacyNote: PRIVACY,
      verify: { code: cnNo, path: `/v1/verify/${encodeURIComponent(cnNo)}`, loginRequired: false },
    };
  }

  /** "Notify me when it's published" for the caller's batches of a consignment. */
  async watch(c: Customer, cnNo: string, watch: boolean) {
    const { runInTransaction, auditService, projectionsService, certificatesRepository } =
      this.deps;
    const batchIds = await projectionsService.batchIdsOfCn(cnNo);
    const owned =
      batchIds.length === 0
        ? []
        : [
            ...new Set(
              (await projectionsService.customerRowsIn(c.userId, batchIds)).map((r) => r.batchId),
            ),
          ];
    if (owned.length === 0) throw new NotFoundError('Consignment');
    await runInTransaction(async (tx) => {
      if (watch) await certificatesRepository.addWatches(tx, c.userId, owned);
      else await certificatesRepository.removeWatches(tx, c.userId, owned);
      for (const batchId of owned)
        await auditService.record(
          tx,
          { userId: c.userId, type: 'CUSTOMER', requestId: c.requestId },
          { action: watch ? 'watch.on' : 'watch.off', targetType: 'batch', targetId: batchId },
        );
    });
    return { cnNo, watching: watch, batches: owned.length };
  }

  /** Users watching a batch (COA feature, when it publishes). */
  watcherIds(tx: Tx, batchId: string) {
    return this.deps.certificatesRepository.watcherIds(tx, batchId);
  }

  // ── Public ──

  /** verify.farmx.in: a unit QR or a CN number → allow-listed facts only (no login). */
  async verify(code: string) {
    const trimmed = code.trim();
    if (/^CN-/i.test(trimmed)) {
      const batchIds = await this.deps.projectionsService.batchIdsOfCn(trimmed);
      if (batchIds.length === 0) throw unverified();
      const cards = await this.cards(batchIds, true);
      return {
        code: trimmed,
        type: 'CONSIGNMENT',
        genuine: true,
        batches: [...cards.values()].map(toPublic),
        privacyNote: PRIVACY,
      };
    }
    const trace = await this.deps.warehouseClient.unitTrace(trimmed);
    if (trace === null) throw unverified();
    const card = (await this.cards([trace.batchId], true)).get(trace.batchId);
    if (card === undefined) throw unverified();
    return {
      code: trimmed,
      type: 'UNIT',
      genuine: true,
      batches: [toPublic(card)],
      privacyNote: PRIVACY,
    };
  }

  // ── Card builder (shared, no buyer data inside) ──

  /** One card per batch: product, verdict, both certificates, parameter table, timelines. */
  async cards(batchIds: readonly string[], withDocs: boolean): Promise<Map<string, Card>> {
    const {
      projectionsService,
      coasService,
      samplesService,
      releaseService,
      labsService,
      mediaClient,
    } = this.deps;
    const ids = [...new Set(batchIds)];
    const out = new Map<string, Card>();
    if (ids.length === 0) return out;
    const [batches, states, coas, samples, holds, lines] = await Promise.all([
      projectionsService.batches(ids),
      releaseService.statesOf(ids),
      coasService.withResults(ids),
      samplesService.ofBatches(ids),
      releaseService.holdsOf(ids),
      projectionsService.receiptLines(ids),
    ]);
    const [variants, labs] = await Promise.all([
      projectionsService.variants([...batches.values()].map((b) => b.variantId)),
      labsService.byIds([
        ...coas.flatMap((c) => (c.labId === null ? [] : [c.labId])),
        ...samples.map((s) => s.labId),
      ]),
    ]);
    const urls = withDocs
      ? await mediaClient.signRead(
          coas.flatMap((c) => (c.mediaKey !== null && c.status === 'APPROVED' ? [c.mediaKey] : [])),
        )
      : {};

    for (const b of batches.values()) {
      const v = variants.get(b.variantId);
      const st = states.get(b.batchId)?.state ?? 'PENDING';
      const mine = coas.filter((c) => c.batchId === b.batchId);
      const mfr = mine.find((c) => c.source === 'MANUFACTURER' && c.status === 'APPROVED') ?? null;
      const ind = mine.find((c) => c.source === 'INDEPENDENT' && c.status === 'APPROVED') ?? null;
      const sample = samples.find((s) => s.batchId === b.batchId) ?? null;
      const hold = holds.find((r) => r.batchId === b.batchId) ?? null;
      const labOf = (id: string | null) => (id === null ? null : (labs.get(id) ?? null));

      const status: CardStatus =
        ind?.verdict === 'FAIL' || st === 'RECALLED'
          ? 'FAILED'
          : st === 'QUARANTINED'
            ? 'QUARANTINED'
            : ind?.verdict === 'PASS'
              ? 'PASS'
              : sample !== null || mfr !== null
                ? 'LAB_PENDING'
                : 'NO_CERTIFICATE';

      const certificates = [mfr, ind].flatMap((c) => {
        if (c === null) return [];
        const lab = labOf(c.labId);
        return [
          {
            source: c.source,
            label:
              c.source === 'MANUFACTURER'
                ? 'Manufacturer COA'
                : `${lab?.name ?? 'Independent lab'} COA`,
            issuer:
              c.source === 'MANUFACTURER'
                ? (c.issuerName ?? b.vendorName)
                : (lab?.name ?? c.issuerName),
            selfDeclared: c.source === 'MANUFACTURER',
            accreditation: c.source === 'INDEPENDENT' ? (lab?.accreditation ?? null) : null,
            analystName: c.analystName,
            signatoryName: c.signatoryName,
            signedOn: ymd(c.issuedAt) ?? ymd(c.reviewedAt),
            labRef: c.certificateRef,
            verdict: c.verdict,
            documentUrl: c.mediaKey === null ? null : (urls[c.mediaKey] ?? null),
          },
        ];
      });

      const codes = [
        ...new Set([...(mfr?.results ?? []), ...(ind?.results ?? [])].map((r) => r.paramCode)),
      ];
      const parameters = codes.flatMap((code) => {
        const m = mfr?.results.find((r) => r.paramCode === code) ?? null;
        const i = ind?.results.find((r) => r.paramCode === code) ?? null;
        const any = i ?? m;
        if (any === null) return [];
        const cell = (r: typeof m) =>
          r === null ? null : { value: r.valueText ?? r.valueNum, verdict: r.verdict };
        return [
          {
            code,
            name: any.paramName,
            unit: any.unit,
            spec: specLabel(any),
            manufacturer: cell(m),
            independent: cell(i),
            failed: i?.verdict === 'FAILS',
          },
        ];
      });

      let pending: Card['pending'] = null;
      if (status === 'LAB_PENDING' && sample !== null) {
        const lab = labOf(sample.labId);
        const step = ['PENDING', 'COLLECTED'].includes(sample.status)
          ? 1
          : ['SENT', 'ACKNOWLEDGED'].includes(sample.status)
            ? 2
            : 3;
        const firstLine = lines.find((l) => l.batchId === b.batchId);
        const join = (parts: (string | null | undefined)[]) => {
          const s = parts
            .filter((p): p is string => p !== null && p !== undefined && p !== '')
            .join(' · ');
          return s === '' ? null : s;
        };
        pending = {
          step,
          of: 4,
          labName: lab?.name ?? null,
          expectedResultAt: sample.expectedResultAt?.toISOString() ?? null,
          steps: [
            {
              label: 'Sample drawn by system instruction',
              detail: join([
                firstLine?.warehouseName,
                sample.collectedAt === null ? null : fmtDay(sample.collectedAt),
                `${String(sample.qty)} ${sample.qtyUnit} at random`,
              ]),
              state: step > 1 ? 'DONE' : 'CURRENT',
            },
            {
              label: `Received at ${lab?.name ?? 'the lab'}`,
              detail: join([
                sample.acknowledgedAt === null ? null : fmtDay(sample.acknowledgedAt),
                sample.labRef,
              ]),
              state: step > 2 ? 'DONE' : step === 2 ? 'CURRENT' : 'PENDING',
            },
            {
              label: 'Testing',
              detail: sample.testingAt === null ? null : fmtDay(sample.testingAt),
              state: step === 3 ? 'CURRENT' : 'PENDING',
            },
            {
              label: 'Published here & on your order',
              detail: 'You and your vet are notified together',
              state: 'PENDING',
            },
          ],
        };
      }

      const timeline =
        status === 'FAILED' && ind !== null
          ? [
              {
                at: (ind.publishedAt ?? ind.reviewedAt ?? ind.updatedAt).toISOString(),
                title: 'Independent COA failed',
                detail: 'Result published automatically',
              },
              ...(hold === null
                ? []
                : [
                    {
                      at: hold.decidedAt.toISOString(),
                      title: 'Consignment quarantined',
                      detail: 'Listings paused',
                    },
                    {
                      at: hold.decidedAt.toISOString(),
                      title: 'Every buyer notified',
                      detail: 'In app',
                    },
                  ]),
            ]
          : [];

      const statusText: Record<CardStatus, string> = {
        PASS: 'Both certificates passed',
        LAB_PENDING:
          mfr !== null && st === 'RELEASED'
            ? 'Released on manufacturer COA. Independent result is not available yet.'
            : 'Independent COA pending',
        FAILED: 'Quarantined — do not use',
        QUARANTINED: 'On hold for quality investigation',
        NO_CERTIFICATE: 'No certificate published yet',
      };

      out.set(b.batchId, {
        batchId: b.batchId,
        batchNo: b.batchNo,
        mfgDate: ymd(b.mfgDate),
        expiryDate: ymd(b.expiryDate),
        vendorName: b.vendorName,
        cnNos: [...new Set(lines.filter((l) => l.batchId === b.batchId).map((l) => l.cnNo))],
        product:
          v === undefined
            ? null
            : {
                name: v.name,
                variantName: v.variantName,
                brandName: v.brandName,
                packLabel: v.packLabel,
                imageUrl: v.imageUrl,
                coldChain: COLD.has(v.temperatureClass) ? 'Cold chain (2–8 °C)' : null,
              },
        status,
        statusText: statusText[status],
        releasedOn:
          st === 'RELEASED'
            ? ind?.verdict === 'PASS'
              ? 'INDEPENDENT_COA'
              : 'MANUFACTURER_COA'
            : null,
        quarantine:
          status === 'FAILED'
            ? {
                since: hold?.decidedAt.toISOString() ?? null,
                text: `QUARANTINED — DO NOT USE. The independent COA failed. Every unit of this consignment was withdrawn from sale${hold === null ? '' : ` on ${fmtDay(hold.decidedAt)}`}.`,
                advice:
                  'Have this product? Keep it apart and do not use it. Open the FarmX app to return it.',
              }
            : null,
        certificates,
        parameters,
        whatFailed: parameters
          .filter((p) => p.failed)
          .map((p) => ({ name: p.name, value: p.independent?.value ?? null, spec: p.spec })),
        mismatch: mfr !== null && ind !== null ? mismatch(mfr.results, ind.results) : null,
        pending,
        timeline,
        policy: POLICY,
      });
    }
    return out;
  }

  /** Scan-result journey. Delivery steps only for the unit's own buyer; Future data = null. */
  private journey(t: UnitTrace, card: Card, own: boolean) {
    const qcApproved = card.certificates.some(
      (c) => c.source === 'MANUFACTURER' && c.verdict === 'PASS',
    );
    const steps: {
      key: string;
      title: string;
      detail: string | null;
      badge: string | null;
      at: string | null;
      reading: null;
    }[] = [
      {
        key: 'VENDOR',
        title: 'Vendor',
        detail: card.vendorName,
        badge: qcApproved ? 'QC Approved' : null,
        at: null,
        reading: null,
      },
    ];
    if (t.receipt !== null)
      steps.push({
        key: 'WAREHOUSE',
        title: t.receipt.warehouseName,
        detail: 'Received and allocated',
        badge: null,
        at: t.receipt.receivedAt,
        reading: null,
      });
    if (own && t.shipment !== null) {
      if (t.shipment.dispatchedAt !== null)
        steps.push({
          key: 'VEHICLE',
          title: t.shipment.vehicleNo ?? 'Delivery vehicle',
          detail: 'Dispatched',
          badge: null,
          at: t.shipment.dispatchedAt,
          reading: null,
        });
      if (t.shipment.deliveredAt !== null) {
        const proof = [
          t.shipment.otpVerified ? 'OTP' : null,
          t.shipment.hasPhotoProof ? 'photo proof' : null,
        ].filter((p) => p !== null);
        steps.push({
          key: 'FARM',
          title: 'Your farm',
          detail: proof.length === 0 ? null : proof.join(' and '),
          badge: t.shipment.otpVerified ? 'Verified' : null,
          at: t.shipment.deliveredAt,
          reading: null,
        });
      }
    }
    return steps;
  }
}
