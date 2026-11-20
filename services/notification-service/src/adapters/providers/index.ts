import type { Logger } from '@farmx/common/logger';

import type { NotificationConfig } from '../../config/index.js';
import { ConsoleEmailProvider, ConsolePushProvider, ConsoleSmsProvider } from './console.js';
import { FcmPushProvider } from './fcm.js';
import { SmtpEmailProvider } from './smtp.js';
import type { EmailProvider, PushProvider, SmsProvider } from './types.js';

export * from './types.js';

/** The configured provider per channel; null = channel off (deliveries SKIPPED). */
export interface Providers {
  push: PushProvider | null;
  email: EmailProvider | null;
  sms: SmsProvider | null;
}

export const buildProviders = (config: NotificationConfig, logger: Logger): Providers => ({
  push:
    config.PUSH_PROVIDER === 'fcm'
      ? new FcmPushProvider(
          config.FCM_SERVICE_ACCOUNT_JSON ?? '',
          config.PROVIDER_TIMEOUT_MS,
          logger,
        )
      : config.PUSH_PROVIDER === 'console'
        ? new ConsolePushProvider(logger)
        : null,
  email:
    config.EMAIL_PROVIDER === 'smtp'
      ? new SmtpEmailProvider(
          config.SMTP_URL ?? '',
          config.EMAIL_FROM,
          config.PROVIDER_TIMEOUT_MS,
          logger,
        )
      : config.EMAIL_PROVIDER === 'console'
        ? new ConsoleEmailProvider(logger)
        : null,
  sms: config.SMS_PROVIDER === 'console' ? new ConsoleSmsProvider(logger) : null,
});
