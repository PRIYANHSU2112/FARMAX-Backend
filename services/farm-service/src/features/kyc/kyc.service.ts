import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import { FARM_EVENTS } from '@farmx/infra/events';
import { farmKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import { Guarded } from '../../adapters/kyc-providers.js';
import type { Actor } from '../audit/index.js';
import type { FarmContext, FarmView } from '../farms/index.js';
import type { Issue } from '../review/index.js';
import { isValidGstin, maskPan, namesMatch, sameBusinessName } from './kyc.checks.js';
import type {
  AadhaarTxn,
  BillingInput,
  DocumentDecisionInput,
  DocumentInput,
  GstView,
  KycDocumentView,
} from './kyc.types.js';

type Deps = Pick<
  Cradle,
  | 'kycRepository'
  | 'farmsService'
  | 'aadhaarProvider'
  | 'gstProvider'
  | 'pii'
  | 'redis'
  | 'cache'
  | 'outbox'
  | 'auditService'
  | 'runInTransaction'
>;

const TXN_TTL = 600;
const MAX_OTP_ATTEMPTS = 5;
const GST_TTL = 86_400;

type KycStatus = FarmView['owner']['kycStatus'];

/**
 * KYC for farm owners. Aadhaar: number → provider → only last 4 + provider ref are kept (D-24).
 * PAN: AES-GCM + HMAC. GSTIN: checksum, then a cached portal lookup. Provider calls are
 * timeout-guarded with a circuit breaker and never run inside a DB transaction.
 */
export class KycService {
  private readonly aadhaarGuard = new Guarded('Aadhaar verification');
  private readonly gstGuard = new Guarded('GST portal');

  constructor(private readonly deps: Deps) {}

  async sendAadhaarOtp(actor: Actor, farmId: string, aadhaarNumber: string) {
    const ctx = await this.deps.farmsService.ownedContext(actor.userId, farmId);
    const { txnRef } = await this.aadhaarGuard.run(() =>
      this.deps.aadhaarProvider.sendOtp(aadhaarNumber),
    );
    const txn: AadhaarTxn = { txnRef, last4: aadhaarNumber.slice(-4), attempts: 0 };
    try {
      await this.deps.redis.set(
        farmKeys.aadhaarTxn(ctx.ownerId),
        JSON.stringify(txn),
        'EX',
        TXN_TTL,
      );
    } catch (cause) {
      throw new ServiceUnavailableError('Verification store unavailable', { cause });
    }
    await this.deps.runInTransaction((tx) =>
      this.deps.farmsService.recordConsent(tx, ctx.ownerId, true, actor.ip),
    );
    return { txnRef, expiresIn: TXN_TTL, maskedAadhaar: `XXXX XXXX ${txn.last4}` };
  }

  async verifyAadhaarOtp(actor: Actor, farmId: string, txnRef: string, otp: string) {
    const ctx = await this.deps.farmsService.ownedContext(actor.userId, farmId);
    const key = farmKeys.aadhaarTxn(ctx.ownerId);
    const raw = await this.deps.redis.get(key).catch((cause: unknown) => {
      throw new ServiceUnavailableError('Verification store unavailable', { cause });
    });
    const txn = raw === null ? null : (JSON.parse(raw) as AadhaarTxn);
    if (txn?.txnRef !== txnRef)
      throw new ValidationError([{ path: 'txnRef', message: 'OTP expired; request a new one' }]);
    if (txn.attempts >= MAX_OTP_ATTEMPTS) {
      await this.deps.redis.del(key).catch(() => undefined);
      throw new ValidationError([
        { path: 'otp', message: 'Too many wrong attempts; request a new OTP' },
      ]);
    }
    await this.deps.redis
      .set(key, JSON.stringify({ ...txn, attempts: txn.attempts + 1 }), 'KEEPTTL')
      .catch(() => undefined);
    const result = await this.aadhaarGuard.run(() =>
      this.deps.aadhaarProvider.verifyOtp(txnRef, otp),
    );
    if (result === null) throw new ValidationError([{ path: 'otp', message: 'Incorrect OTP' }]);
    await this.deps.redis.del(key).catch(() => undefined);

    const nameMatch = namesMatch(result.name, ctx.farm.owner.fullName);
    await this.inTx(
      actor,
      ctx,
      async (tx) => {
        await this.deps.farmsService.updateOwnerInTx(tx, ctx.ownerId, {
          aadhaarLast4: txn.last4,
          aadhaarRefId: result.refId,
          aadhaarNameMatch: nameMatch,
          aadhaarVerifiedAt: new Date(),
        });
      },
      true,
    );
    return { verified: true, aadhaarLast4: txn.last4, nameMatch };
  }

  async setPan(actor: Actor, farmId: string, pan: string) {
    const ctx = await this.deps.farmsService.ownedContext(actor.userId, farmId);
    // Lock icon on the Documents screen: an accepted PAN card freezes the number.
    if (ctx.farm.owner.panVerified)
      throw new ConflictError('Your PAN is verified and locked. Contact support to change it.', {
        details: { reason: 'PAN_LOCKED' },
      });
    const { pii } = this.deps;
    const panMasked = maskPan(pan);
    const status = await this.inTx(
      actor,
      ctx,
      async (tx) => {
        await this.deps.farmsService.updateOwnerInTx(tx, ctx.ownerId, {
          panCipher: new Uint8Array(pii.encrypt(pan)),
          panKeyId: pii.keyId,
          panHash: pii.hash('pan', pan),
          panMasked,
        });
      },
      true,
    );
    return { panMasked, kycStatus: status };
  }

  async addDocument(actor: Actor, farmId: string, input: DocumentInput): Promise<KycDocumentView> {
    const ctx = await this.deps.farmsService.ownedContext(actor.userId, farmId);
    let doc: KycDocumentView | undefined;
    await this.inTx(
      actor,
      ctx,
      async (tx) => {
        doc = await this.deps.kycRepository.addDocument(
          tx,
          ctx.ownerId,
          farmId,
          actor.userId,
          input,
        );
      },
      true,
    );
    if (doc === undefined) throw new Error('document not created');
    return doc;
  }

  /** GSTIN → checksum → cached portal snapshot (24 h) → stored verification row. */
  async verifyGstin(actor: Actor, farmId: string, gstin: string): Promise<GstView> {
    if (!isValidGstin(gstin))
      throw new ValidationError([{ path: 'gstin', message: 'GSTIN checksum is invalid' }]);
    const { farmsService } = this.deps;
    const ctx = await farmsService.ownedContext(actor.userId, farmId);
    const [record, farmState] = await Promise.all([
      this.deps.cache.getOrSet(farmKeys.gstin(gstin), GST_TTL, () =>
        this.gstGuard.run(() => this.deps.gstProvider.lookup(gstin)),
      ),
      farmsService.territoryStateCode(ctx.farm.location?.territoryCode ?? null),
    ]);
    if (record === null)
      throw new ValidationError([{ path: 'gstin', message: 'GSTIN not found on the GST portal' }]);
    if (record.status !== 'ACTIVE')
      throw new ValidationError([
        { path: 'gstin', message: `GSTIN is ${record.status.toLowerCase()} on the GST portal` },
      ]);
    const [saved, owner] = await Promise.all([
      this.deps.kycRepository.addGstVerification(record, this.deps.gstProvider.name, actor.userId),
      farmsService.findOwnerPan(ctx.ownerId),
    ]);
    const farmName = ctx.farm.name;
    const nameMatchesFarm =
      sameBusinessName(record.tradeName ?? record.legalName, farmName) ||
      sameBusinessName(record.legalName, farmName);
    return {
      verificationId: saved.id,
      gstin,
      tradeName: record.tradeName,
      legalName: record.legalName,
      businessName: record.legalName,
      stateCode: record.stateCode,
      stateMatchesFarm: farmState === null ? null : farmState === record.stateCode,
      portalStatus: record.status,
      checkedAt: saved.checkedAt.toISOString(),
      nameMatchesFarm,
      panMatchesGstin:
        owner?.panHash == null
          ? null
          : owner.panHash === this.deps.pii.hash('pan', gstin.slice(2, 12)),
      options: ['GST_TRADE_NAME', 'FARM_NAME'],
    };
  }

  /**
   * "Invoice as …" (B2B GST registration step): binds a verified GSTIN to the farm. Business and
   * trade names come only from the portal snapshot, never from the client. The check must be
   * fresh (≤ 24 h) and the GSTIN must be registered in the farm's state, otherwise the buyer's
   * input tax credit would be invalid. The farm write emits `farm.facts_changed.v1` (gstVerified).
   */
  async setBilling(actor: Actor, farmId: string, input: BillingInput): Promise<FarmView> {
    const { farmsService } = this.deps;
    const ctx = await farmsService.ownedContext(actor.userId, farmId);
    const [v, farmState] = await Promise.all([
      this.deps.kycRepository.findGstVerification(input.verificationId),
      farmsService.territoryStateCode(ctx.farm.location?.territoryCode ?? null),
    ]);
    if (v?.requestedBy !== actor.userId || v.portalStatus !== 'ACTIVE')
      throw new NotFoundError('GST verification');
    if (Date.now() - v.checkedAt.getTime() > GST_TTL * 1000)
      throw new ValidationError([
        {
          path: 'body.verificationId',
          message: 'GST check is older than 24 hours; verify the GSTIN again',
        },
      ]);
    if (farmState !== null && farmState !== v.stateCode)
      throw new ValidationError([
        {
          path: 'body.verificationId',
          message: `GSTIN is registered in state ${v.stateCode}, but this farm is in state ${farmState}`,
        },
      ]);
    const gstName = v.tradeName ?? v.legalName;
    const farmName = ctx.farm.name;
    const review = ctx.farm.billing.invoiceNameReview;
    // "Keep farm name & send for review": the GST names differ from the farm name, so a FARM_NAME
    // invoice needs staff approval first (an approval for the same GSTIN + name stays valid).
    const wantsFarmName = input.invoiceNameSource === 'FARM_NAME';
    // Same rule as `nameMatchesFarm` in the GSTIN check, so the banner and the review agree.
    const namesDiffer =
      !sameBusinessName(gstName, farmName) && !sameBusinessName(v.legalName, farmName);
    const alreadyApproved =
      review?.status === 'APPROVED' &&
      ctx.farm.billing.gstin === v.gstin &&
      ctx.farm.billing.invoiceName === farmName;
    const needsReview = wantsFarmName && namesDiffer && !alreadyApproved;
    const useFarmName = wantsFarmName && !needsReview;
    const view = await this.deps.runInTransaction(async (tx) => {
      await farmsService.patchInTx(tx, ctx.farm, {
        gstin: v.gstin,
        gstVerificationId: v.id,
        // While the review is pending, invoices carry the GST trade name (valid for ITC).
        invoiceNameSource: useFarmName ? 'FARM_NAME' : 'GST_TRADE_NAME',
        invoiceName: useFarmName ? farmName : gstName,
        gstBusinessName: v.legalName,
        gstTradeName: v.tradeName,
        gstVerifiedAt: v.checkedAt,
        registrationStep: Math.max(ctx.farm.registrationStep, 4),
        ...(alreadyApproved && wantsFarmName
          ? {}
          : {
              invoiceNameReview: needsReview ? 'PENDING' : null,
              invoiceNameRequestedAt: needsReview ? new Date() : null,
              invoiceNameReviewedById: null,
              invoiceNameReviewedAt: null,
              invoiceNameReviewNote: null,
            }),
      });
      if (needsReview)
        await this.deps.auditService.record(tx, actor, {
          action: 'farm.invoice_name_review_requested',
          targetType: 'farm',
          targetId: farmId,
          before: { invoiceName: ctx.farm.billing.invoiceName },
          after: { requestedInvoiceName: farmName, gstTradeName: gstName },
        });
      return { ...ctx.farm };
    });
    await this.deps.farmsService.invalidate(view);
    return this.deps.farmsService.getOwned(actor.userId, farmId);
  }

  /** Rejected, not yet replaced documents → the "Verification failed" screen. */
  async openIssues(ownerId: string): Promise<Issue[]> {
    const docs = await this.deps.kycRepository.listCurrent(ownerId);
    return docs
      .filter((d) => d.status === 'REJECTED')
      .map((d) => ({
        docType: d.docType,
        code: d.rejectionCode ?? 'OTHER',
        message: d.rejectionNote ?? 'Please upload this document again',
      }));
  }

  // ── Admin ──

  async listDocuments(farmId: string): Promise<KycDocumentView[]> {
    const farm = await this.deps.farmsService.internalGet(farmId);
    return this.deps.kycRepository.listCurrent(farm.owner.id);
  }

  async decideDocument(
    actor: Actor,
    farmId: string,
    docId: string,
    input: DocumentDecisionInput,
  ): Promise<KycDocumentView> {
    const farm = await this.deps.farmsService.internalGet(farmId);
    if (farm.owner.userId === actor.userId || farm.createdByUserId === actor.userId) {
      throw new ForbiddenError('You cannot review documents of a registration you created or own', {
        details: { reason: 'SOD_VIOLATION' },
      });
    }
    const doc = await this.deps.kycRepository.findDocument(docId, farm.owner.id);
    if (doc === null) throw new NotFoundError('Document');
    const ctx: FarmContext = { farm, ownerId: farm.owner.id, ownerUserId: farm.owner.userId };
    await this.inTx(
      actor,
      ctx,
      async (tx) => {
        const accepted = input.decision === 'ACCEPT';
        const done = await this.deps.kycRepository.decide(tx, docId, {
          status: accepted ? 'ACCEPTED' : 'REJECTED',
          rejectionCode: accepted ? null : (input.rejectionCode ?? 'OTHER'),
          rejectionNote: accepted ? null : (input.note ?? null),
          reviewedByUserId: actor.userId,
        });
        if (!done) throw new ConflictError('Document already decided or replaced');
        if (accepted && doc.docType === 'PAN_CARD') {
          await this.deps.farmsService.updateOwnerInTx(tx, ctx.ownerId, {
            panVerifiedAt: new Date(),
          });
        }
        await this.deps.auditService.record(tx, actor, {
          action: `kyc.document.${accepted ? 'accept' : 'reject'}`,
          targetType: 'document',
          targetId: docId,
          before: { status: doc.status },
          after: {
            status: accepted ? 'ACCEPTED' : 'REJECTED',
            rejectionCode: input.rejectionCode ?? null,
          },
          reason: input.reason,
        });
      },
      false,
    );
    const updated = await this.deps.kycRepository.findDocument(docId, farm.owner.id);
    if (updated === null) throw new NotFoundError('Document');
    return updated;
  }

  // ── Internals ──

  /**
   * Runs a KYC change, then recomputes the owner's KYC status in the same transaction and emits
   * `farm.owner_kyc_changed.v1` when it moved. Caches are invalidated after commit.
   */
  private async inTx(
    actor: Actor,
    ctx: FarmContext,
    work: (tx: Tx) => Promise<void>,
    byOwner: boolean,
  ): Promise<KycStatus> {
    const status = await this.deps.runInTransaction(async (tx) => {
      await work(tx);
      const owner = (await this.deps.farmsService.findInTx(tx, ctx.farm.id)).owner;
      const docs = await this.deps.kycRepository.listCurrent(ctx.ownerId, tx);
      // Accepted documents are never superseded, so they are in `docs` (no extra round trip).
      const panAccepted = docs.some((d) => d.docType === 'PAN_CARD' && d.status === 'ACCEPTED');
      const aadhaarOk = owner.aadhaarLast4 !== null;
      let next: KycStatus = 'NOT_STARTED';
      if (docs.some((d) => d.status === 'REJECTED')) next = 'REJECTED';
      else if (aadhaarOk && panAccepted) next = 'VERIFIED';
      else if (aadhaarOk || owner.panMasked !== null || docs.length > 0) next = 'PENDING';
      if (next !== owner.kycStatus) {
        await this.deps.farmsService.updateOwnerInTx(tx, ctx.ownerId, {
          kycStatus: next,
          kycStatusChangedAt: new Date(),
        });
        await this.deps.outbox.add(
          tx,
          FARM_EVENTS.ownerKycChanged,
          { ownerId: ctx.ownerId, ownerUserId: ctx.ownerUserId, kycStatus: next },
          actor.requestId,
        );
      }
      if (
        byOwner &&
        ctx.farm.registrationStep < 4 &&
        ['DRAFT', 'NEEDS_ATTENTION'].includes(ctx.farm.status)
      ) {
        await this.deps.farmsService.patchInTx(tx, ctx.farm, { registrationStep: 4 });
      }
      return next;
    });
    await this.deps.farmsService.invalidate(ctx.farm);
    return status;
  }
}
