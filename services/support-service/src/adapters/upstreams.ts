import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  AppError,
  ErrorCode,
  ServiceUnavailableError,
  ValidationError,
} from '@farmx/common/errors';
import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';

import type { SupportConfig } from '../config/index.js';

interface Deps {
  config: Readonly<SupportConfig>;
  logger: Logger;
}

/**
 * Service-to-service calls (`/internal/*`, shared token, never through the gateway). Called ONLY
 * before a DB transaction opens. Timeout 2 s, one retry on a network error / 5xx; 404 → null.
 */
class InternalHttp {
  constructor(
    private readonly baseUrl: string,
    private readonly name: string,
    private readonly deps: Deps,
  ) {}

  get<T>(path: string): Promise<T | null> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body: unknown): Promise<T | null> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const token = this.deps.config.INTERNAL_SERVICE_TOKEN;
    if (token === undefined)
      throw new ServiceUnavailableError(`${this.name} is not configured (INTERNAL_SERVICE_TOKEN)`);
    for (let attempt = 1; ; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            [INTERNAL_TOKEN_HEADER]: token,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(2_000),
        });
      } catch (err) {
        if (attempt < 2) continue;
        this.deps.logger.warn({ err, service: this.name, path }, 'internal call failed');
        throw new ServiceUnavailableError(`${this.name} is unavailable; try again`, { cause: err });
      }
      if (res.status === 404) return null;
      const json = (await res.json().catch(() => ({}))) as {
        data?: T;
        error?: { message?: string };
      };
      if (res.ok) return json.data ?? null;
      if (res.status >= 500 && attempt < 2) continue;
      if (res.status >= 500 || res.status === 429)
        throw new ServiceUnavailableError(`${this.name} is unavailable; try again`);
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        json.error?.message ?? `${this.name} refused the request`,
        400,
      );
    }
  }
}

// ── auth-service ──

export interface UserContact {
  id: string;
  userType: string;
  status: string;
  fullName: string;
  phone: string | null;
}

export class AuthDirectory {
  private readonly http: InternalHttp;

  constructor(deps: Deps) {
    this.http = new InternalHttp(deps.config.AUTH_SERVICE_URL, 'auth-service', deps);
  }

  /** Name + phone of a requester (queue display, call-me-back). Null = unknown user. */
  contact(userId: string): Promise<UserContact | null> {
    return this.http.get<UserContact>(`/internal/users/${encodeURIComponent(userId)}/contact`);
  }
}

// ── order-service ──

/** The order fields a ticket snapshots (taken once at create; reads never call order-service). */
export interface OrderSnapshot {
  orderId: string;
  orderNo: string;
  status: string;
  placedAt: string;
  grandTotal: string;
  paymentMethod: string;
  itemCount: number;
  firstItemName: string | null;
  temperatureClasses: string[];
}

interface InternalOrder {
  id: string;
  userId: string;
  orderNo: string;
  status: string;
  placedAt: string;
  grandTotal: string;
  paymentMethod: string;
  itemCount: number;
  firstItemName: string | null;
  lines: { temperatureClass: string }[];
}

export class OrderClient {
  private readonly http: InternalHttp;

  constructor(deps: Deps) {
    this.http = new InternalHttp(deps.config.ORDER_SERVICE_URL, 'order-service', deps);
  }

  /** The order when it belongs to `userId` (anyone else's order answers null, like a 404). */
  async snapshotFor(orderId: string, userId: string): Promise<OrderSnapshot | null> {
    const order = await this.http.get<InternalOrder>(
      `/internal/orders/${encodeURIComponent(orderId)}`,
    );
    if (order?.userId !== userId) return null;
    return {
      orderId: order.id,
      orderNo: order.orderNo,
      status: order.status,
      placedAt: order.placedAt,
      grandTotal: order.grandTotal,
      paymentMethod: order.paymentMethod,
      itemCount: order.itemCount,
      firstItemName: order.firstItemName,
      temperatureClasses: [...new Set(order.lines.map((l) => l.temperatureClass))],
    };
  }
}

// ── media-service ──

/** A verified upload: what media-service signed when the file was stored. */
export interface VerifiedUpload {
  key: string;
  uploaderId: string;
  kind: 'image' | 'document';
  mime: string;
  size: number;
  fileName: string | null;
  /** UNSCANNED = PDF stored without clamd (accepted outside prod only). */
  scanStatus: 'CLEAN' | 'REENCODED' | 'UNSCANNED';
}

interface ReceiptPayload extends VerifiedUpload {
  purpose: string;
  exp: number;
}

export const EVIDENCE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;

export class MediaClient {
  private readonly http: InternalHttp;

  constructor(private readonly deps: Deps) {
    this.http = new InternalHttp(deps.config.MEDIA_SERVICE_URL, 'media-service', deps);
  }

  /**
   * Verifies upload receipts LOCALLY (HMAC of media-service, shared internal secret): no network.
   * A receipt proves the file was stored by media-service for THIS uploader, with this type, size
   * and scan result. Raw keys / URLs from clients are never accepted.
   */
  verifyReceipts(receipts: readonly string[], uploaderId: string): VerifiedUpload[] {
    const secret = this.deps.config.INTERNAL_SERVICE_TOKEN;
    if (receipts.length > 0 && secret === undefined)
      throw new ServiceUnavailableError('Attachments are not configured');
    const now = Math.floor(Date.now() / 1000);
    const prod = this.deps.config.APP_ENV === 'prod';
    const seen = new Set<string>();
    return receipts.map((receipt, i) => {
      const payload = verifyReceipt(receipt, secret ?? '');
      const problem = receiptProblem(payload, uploaderId, now, prod, seen);
      if (problem !== null || payload === null)
        throw new ValidationError([
          { path: `body.attachments[${String(i)}]`, message: `File ${problem ?? 'is invalid'}` },
        ]);
      seen.add(payload.key);
      return {
        key: payload.key,
        uploaderId: payload.uploaderId,
        kind: payload.kind,
        mime: payload.mime,
        size: payload.size,
        fileName: payload.fileName,
        scanStatus: payload.scanStatus,
      };
    });
  }

  /** Short-lived signed GET URLs for private keys (caller already checked ticket access). */
  async signRead(keys: readonly string[]): Promise<Record<string, string>> {
    if (keys.length === 0) return {};
    const res = await this.http.post<{ urls: Record<string, string> }>(
      '/internal/media/sign-read',
      {
        keys,
        expiresInSeconds: 300,
      },
    );
    return res?.urls ?? {};
  }

  /** Deletes private files (account deletion scrub). Idempotent. */
  async remove(keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 100)
      await this.http.post('/internal/media/delete', { keys: keys.slice(i, i + 100) });
  }
}

/** Why a receipt is refused (null = acceptable). Exported for unit tests. */
export function receiptProblem(
  payload: ReceiptPayload | null,
  uploaderId: string,
  nowEpochSec: number,
  prod: boolean,
  seen: ReadonlySet<string>,
): string | null {
  if (payload === null) return 'is not a valid upload receipt';
  if (payload.exp < nowEpochSec) return 'has expired; upload the file again';
  if (payload.purpose !== 'support' || payload.uploaderId !== uploaderId)
    return 'was not uploaded by you for support';
  if (!EVIDENCE_MIME.has(payload.mime)) return 'must be a JPEG, PNG, WebP image or a PDF';
  if (payload.size > EVIDENCE_MAX_BYTES) return 'must be at most 10 MB';
  if (payload.scanStatus === 'UNSCANNED' && prod) return 'was not virus-scanned';
  if (seen.has(payload.key)) return 'is attached twice';
  return null;
}

/** `base64url(json).base64url(hmacSha256(json))` — the format media-service signs. */
export function verifyReceipt(receipt: string, secret: string): ReceiptPayload | null {
  if (typeof receipt !== 'string' || receipt.length > 2048) return null;
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
