import { createHmac, timingSafeEqual } from 'node:crypto';

import { ServiceUnavailableError, ValidationError } from '@farmx/common/errors';
import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';

import type { WarehouseConfig } from '../config/index.js';

/** What media-service signs for a private upload (`?purpose=staff_document`). */
interface ReceiptPayload {
  purpose: string;
  key: string;
  uploaderId: string;
  kind: 'image' | 'document';
  mime: string;
  size: number;
  fileName: string | null;
  scanStatus: 'CLEAN' | 'REENCODED' | 'UNSCANNED';
  exp: number;
}

export interface VerifiedDocument {
  key: string;
  mime: string;
  size: number;
  fileName?: string | null;
}

const DOC_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const DOC_MAX_BYTES = 10 * 1024 * 1024;
/** D-62 gate documents (scans, TIFF re-encoded by media-service). */
const GATE_DOC_MAX_BYTES = 25 * 1024 * 1024;

/** `base64url(json).base64url(hmacSha256(json))`, signed by media-service with the shared secret. */
export function verifyReceipt(receipt: string, secret: string): ReceiptPayload | null {
  if (receipt.length > 2048) return null;
  const dot = receipt.indexOf('.');
  if (dot <= 0) return null;
  const body = receipt.slice(0, dot);
  const sig = Buffer.from(receipt.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', secret).update(body).digest();
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ReceiptPayload;
  } catch {
    return null;
  }
}

/** Private upload purposes warehouse-service accepts: staff ID documents (D-56); COA, POD, compliance and weigh-slip files (D-57). */
export type MediaPurpose = 'staff_document' | 'wms_document' | 'gate_document';

const PURPOSE_LABEL: Record<MediaPurpose, string> = {
  staff_document: 'staff document',
  wms_document: 'warehouse document',
  gate_document: 'gate document',
};

/** Why a staff-document receipt is refused (null = acceptable). Exported for unit tests. */
export function receiptProblem(
  p: ReceiptPayload | null,
  uploaderId: string,
  nowSec: number,
  prod: boolean,
  purpose: MediaPurpose = 'staff_document',
): string | null {
  if (p === null) return 'is not a valid upload receipt';
  if (p.exp < nowSec) return 'has expired; upload the file again';
  if (p.purpose !== purpose || p.uploaderId !== uploaderId)
    return `was not uploaded by you as a ${PURPOSE_LABEL[purpose]}`;
  if (!DOC_MIME.has(p.mime)) return 'must be a JPEG, PNG, WebP image or a PDF';
  const max = purpose === 'gate_document' ? GATE_DOC_MAX_BYTES : DOC_MAX_BYTES;
  if (p.size > max) return `must be at most ${String(max / (1024 * 1024))} MB`;
  if (p.scanStatus === 'UNSCANNED' && prod) return 'was not virus-scanned';
  return null;
}

/**
 * media-service for staff identity documents (D-56): receipts are verified LOCALLY (HMAC, no
 * network; raw keys / URLs from clients are never accepted) and files are read only through
 * 5-minute signed URLs.
 */
export class MediaClient {
  constructor(private readonly deps: { config: WarehouseConfig; logger: Logger }) {}

  verify(
    receipt: string,
    uploaderId: string,
    field: string,
    purpose: MediaPurpose = 'staff_document',
  ): VerifiedDocument {
    const secret = this.deps.config.INTERNAL_SERVICE_TOKEN;
    if (secret === undefined)
      throw new ServiceUnavailableError('Document uploads are not configured');
    const payload = verifyReceipt(receipt, secret);
    const problem = receiptProblem(
      payload,
      uploaderId,
      Math.floor(Date.now() / 1000),
      this.deps.config.APP_ENV === 'prod',
      purpose,
    );
    if (problem !== null || payload === null)
      throw new ValidationError([{ path: field, message: `File ${problem ?? 'is invalid'}` }]);
    return {
      key: payload.key,
      mime: payload.mime,
      size: payload.size,
      fileName: payload.fileName,
    };
  }

  /**
   * Deletes private objects (D-62 PII retention: driver licence / RC scans). Returns the number
   * deleted, or null when media-service could not be reached (the job retries later).
   */
  async deleteKeys(keys: readonly string[]): Promise<number | null> {
    const { config, logger } = this.deps;
    if (keys.length === 0) return 0;
    if (config.INTERNAL_SERVICE_TOKEN === undefined) return null;
    try {
      const res = await fetch(`${config.MEDIA_SERVICE_URL}/internal/media/delete`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN,
        },
        body: JSON.stringify({ keys }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: { deleted?: number } };
      return body.data?.deleted ?? 0;
    } catch (err) {
      logger.warn({ err }, 'media-service delete failed');
      return null;
    }
  }

  /** Short-lived signed GET URLs (the caller already checked access). Empty on failure. */
  async signRead(keys: readonly string[]): Promise<Record<string, string>> {
    const { config, logger } = this.deps;
    if (keys.length === 0 || config.INTERNAL_SERVICE_TOKEN === undefined) return {};
    try {
      const res = await fetch(`${config.MEDIA_SERVICE_URL}/internal/media/sign-read`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN,
        },
        body: JSON.stringify({ keys, expiresInSeconds: 300 }),
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) return {};
      const body = (await res.json()) as { data?: { urls?: Record<string, string> } };
      return body.data?.urls ?? {};
    } catch (err) {
      logger.warn({ err }, 'media-service sign-read failed');
      return {};
    }
  }
}
