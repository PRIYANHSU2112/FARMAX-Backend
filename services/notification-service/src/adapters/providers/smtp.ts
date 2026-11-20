import type { Logger } from '@farmx/common/logger';
import nodemailer, { type Transporter } from 'nodemailer';

import { type EmailMessage, type EmailProvider, type SendResult, maskEmail } from './types.js';

/** Network / server-side failures worth retrying (nodemailer error codes). */
const RETRYABLE_CODES = new Set([
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'ECONNRESET',
  'ECONNREFUSED',
]);

/**
 * Email over SMTP (works with Amazon SES, Zoho, Gmail Workspace, Postmark …). Pooled
 * connections. SMTP 4xx = temporary (retry), 5xx = permanent (bad mailbox, rejected).
 */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  private readonly transport: Transporter;

  constructor(
    url: string,
    private readonly from: string,
    timeoutMs: number,
    private readonly logger: Logger,
  ) {
    this.transport = nodemailer.createTransport(url, {
      pool: true,
      maxConnections: 5,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
    } as never);
  }

  async send(message: EmailMessage): Promise<SendResult> {
    try {
      const info = (await this.transport.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      })) as { messageId?: string };
      return { ok: true, providerMessageId: info.messageId ?? null };
    } catch (err) {
      const e = err as { code?: string; responseCode?: number; message?: string };
      const retryable =
        (e.responseCode !== undefined && e.responseCode < 500) ||
        (e.responseCode === undefined && RETRYABLE_CODES.has(e.code ?? ''));
      this.logger.warn(
        { to: maskEmail(message.to), code: e.code, responseCode: e.responseCode, retryable },
        'smtp send failed',
      );
      return {
        ok: false,
        retryable,
        code:
          e.responseCode === undefined
            ? (e.code ?? 'SMTP_ERROR')
            : `SMTP_${String(e.responseCode)}`,
        message: (e.message ?? 'smtp error').slice(0, 200),
      };
    }
  }

  close(): void {
    this.transport.close();
  }
}
