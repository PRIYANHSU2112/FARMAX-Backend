import { randomUUID } from 'node:crypto';

import type { Logger } from '@farmx/common/logger';

import {
  type EmailMessage,
  type EmailProvider,
  type PushMessage,
  type PushProvider,
  type PushResult,
  type SendResult,
  type SmsMessage,
  type SmsProvider,
  maskEmail,
  maskPhone,
} from './types.js';

/**
 * DEV ONLY: log instead of sending (addresses masked, tokens never logged). Config refuses
 * `console` providers when APP_ENV=prod.
 */
export class ConsolePushProvider implements PushProvider {
  readonly name = 'console';
  constructor(private readonly logger: Logger) {}

  send(message: PushMessage): Promise<PushResult> {
    this.logger.info(
      { devices: message.tokens.length, title: message.title, data: message.data },
      '[DEV PUSH] not sent: console provider',
    );
    return Promise.resolve({
      sent: message.tokens.length,
      providerMessageId: `console-${randomUUID()}`,
      invalidTokenIds: [],
      retryable: false,
      error: null,
    });
  }
}

export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';
  constructor(private readonly logger: Logger) {}

  send(message: EmailMessage): Promise<SendResult> {
    this.logger.info(
      { to: maskEmail(message.to), subject: message.subject, text: message.text },
      '[DEV EMAIL] not sent: console provider',
    );
    return Promise.resolve({ ok: true, providerMessageId: `console-${randomUUID()}` });
  }
}

export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';
  constructor(private readonly logger: Logger) {}

  send(message: SmsMessage): Promise<SendResult> {
    this.logger.info(
      { to: maskPhone(message.to), text: message.text },
      '[DEV SMS] not sent: console provider',
    );
    return Promise.resolve({ ok: true, providerMessageId: `console-${randomUUID()}` });
  }
}
