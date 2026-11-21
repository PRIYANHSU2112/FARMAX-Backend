import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  ExternalServiceError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  ValidationError,
} from '@farmx/common/errors';
import type { Cradle } from '@fastify/awilix';

import { scanWithClamd } from '../../adapters/clamav.js';
import type { IncomingFile } from './media.types.js';
import { readHead, resolveAllowedType } from './processing/detect.js';
import { compressImage } from './processing/image.js';
import { uuidv7 } from './processing/uuidv7.js';

/** Support evidence: images and PDFs only, ≤ 10 MB, private, receipt valid 1 h. */
const SUPPORT_MAX_BYTES = 10 * 1024 * 1024;
const RECEIPT_TTL_SECONDS = 3600;

export type ScanStatus = 'CLEAN' | 'REENCODED' | 'UNSCANNED';

export interface SupportUpload {
  key: string;
  kind: 'image' | 'document';
  contentType: string;
  size: number;
  fileName: string | null;
  scanStatus: ScanStatus;
  /** Signed proof for support-service (who uploaded what, scanned how). Opaque to the app. */
  receipt: string;
  receiptExpiresAt: string;
}

/** `base64url(json).base64url(hmacSha256(json))` — verified by support-service with the same secret. */
export const signReceipt = (payload: object, secret: string): string => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
};

/**
 * Private uploads for support tickets. Never public: stored under `<folder>/support/`, read only
 * through 5-minute signed URLs that support-service requests after checking ticket access.
 * Images are re-encoded (strips embedded payloads); PDFs are scanned by clamd (prod: required).
 */
export class SupportUploads {
  constructor(private readonly deps: Pick<Cradle, 'storage' | 'config' | 'logger'>) {}

  get prefix(): string {
    return `${this.deps.config.BUCKET_FOLDER_PATH}/support/`;
  }

  async upload(file: IncomingFile, uploaderId: string): Promise<SupportUpload> {
    const secret = this.deps.config.INTERNAL_SERVICE_TOKEN;
    if (secret === undefined) throw new ServiceUnavailableError('Support uploads are not configured');
    const allowed = resolveAllowedType({ ...file, head: await readHead(file.path) });
    if (allowed.kind !== 'image' && allowed.kind !== 'document')
      throw new ValidationError([{ path: 'file', message: 'Support evidence must be a photo or a PDF' }]);
    if (file.size > SUPPORT_MAX_BYTES) throw new PayloadTooLargeError('Support files must be at most 10 MB');

    let body: Buffer;
    let contentType: string;
    let extension: string;
    let scanStatus: ScanStatus;
    if (allowed.kind === 'image') {
      const image = await compressImage(file.path);
      ({ body, contentType, extension } = image);
      scanStatus = 'REENCODED';
    } else {
      body = await readFile(file.path);
      contentType = 'application/pdf';
      extension = 'pdf';
      scanStatus = await this.scan(body);
    }

    const key = `${this.prefix}${uuidv7()}.${extension}`;
    try {
      await this.deps.storage.putPrivateObject({ key, body, contentType });
    } catch (error) {
      throw new ExternalServiceError('spaces', { cause: error });
    }
    const exp = Math.floor(Date.now() / 1000) + RECEIPT_TTL_SECONDS;
    const fileName = file.filename.slice(0, 160);
    const receipt = signReceipt(
      { purpose: 'support', key, uploaderId, kind: allowed.kind, mime: contentType, size: body.length, fileName, scanStatus, exp },
      secret,
    );
    this.deps.logger.info({ key, kind: allowed.kind, size: body.length, scanStatus }, 'support evidence uploaded');
    return {
      key,
      kind: allowed.kind,
      contentType,
      size: body.length,
      fileName,
      scanStatus,
      receipt,
      receiptExpiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  /** Signed GET URLs for support keys only (callers outside this prefix get nothing). */
  async signRead(keys: readonly string[], expiresInSeconds: number): Promise<Record<string, string>> {
    const own = keys.filter((k) => k.startsWith(this.prefix));
    const urls = await Promise.all(own.map((k) => this.deps.storage.signedGetUrl(k, expiresInSeconds)));
    return Object.fromEntries(own.map((k, i) => [k, urls[i] ?? '']));
  }

  async remove(keys: readonly string[]): Promise<number> {
    const own = keys.filter((k) => k.startsWith(this.prefix));
    if (own.length > 0) await this.deps.storage.deleteObjects(own);
    return own.length;
  }

  private async scan(body: Buffer): Promise<ScanStatus> {
    const { CLAMAV_HOST, CLAMAV_PORT, APP_ENV } = this.deps.config;
    if (CLAMAV_HOST === undefined) {
      if (APP_ENV === 'prod') throw new ServiceUnavailableError('PDF scanning is not available; send a photo instead');
      this.deps.logger.warn('CLAMAV_HOST not set: support PDF stored UNSCANNED (dev only)');
      return 'UNSCANNED';
    }
    let verdict: { clean: boolean; signature: string | null };
    try {
      verdict = await scanWithClamd(body, CLAMAV_HOST, CLAMAV_PORT);
    } catch (error) {
      throw new ServiceUnavailableError('The virus scanner is unavailable; try again', { cause: error });
    }
    if (!verdict.clean) {
      this.deps.logger.warn({ signature: verdict.signature }, 'infected support upload refused');
      throw new ValidationError([{ path: 'file', message: 'The file failed the virus scan' }]);
    }
    return 'CLEAN';
  }
}
