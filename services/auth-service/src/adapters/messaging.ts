import type { Logger } from '@farmx/common/logger';

/** Outbound SMS (OTP, alerts). Real providers (DLT-registered templates) plug in here. */
export interface SmsSender {
  send(to: string, message: string): Promise<void>;
}

/** Outbound email (password-reset codes for staff without a phone). */
export interface EmailSender {
  send(to: string, subject: string, text: string): Promise<void>;
}

const mask = (value: string): string =>
  value.includes('@')
    ? value.replace(/^(.).*(@.*)$/, '$1***$2')
    : value.replace(/^(\+\d{2})\d+(\d{4})$/, '$1******$2');

/**
 * DEV ONLY: writes the message to the log instead of sending it, so the OTP can be read locally.
 * Config refuses `SMS_PROVIDER=console` when APP_ENV=prod.
 */
export class ConsoleSmsSender implements SmsSender {
  constructor(private readonly logger: Logger) {}

  async send(to: string, message: string): Promise<void> {
    this.logger.warn(
      { to: mask(to), devMessage: message },
      '[DEV SMS] not sent — console provider',
    );
  }
}

/** DEV ONLY: see ConsoleSmsSender. */
export class ConsoleEmailSender implements EmailSender {
  constructor(private readonly logger: Logger) {}

  async send(to: string, subject: string, text: string): Promise<void> {
    this.logger.warn(
      { to: mask(to), subject, devMessage: text },
      '[DEV EMAIL] not sent — console provider',
    );
  }
}
