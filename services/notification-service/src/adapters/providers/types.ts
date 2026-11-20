/**
 * Channel providers. Business code depends only on these interfaces; the concrete provider is
 * chosen by config (container.ts). Every result classifies failures: `retryable` (timeouts, 5xx,
 * throttling → backoff) or permanent (bad address / token → FAILED, no retry).
 */

export type SendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; retryable: boolean; code: string; message: string };

export interface PushToken {
  id: string;
  token: string;
}

export interface PushMessage {
  tokens: readonly PushToken[];
  title: string;
  body: string;
  /** FCM data payload (string values only): notificationId + deep link ids. */
  data: Readonly<Record<string, string>>;
}

export interface PushResult {
  /** At least one device accepted it. */
  sent: number;
  providerMessageId: string | null;
  /** Tokens the provider says are dead (unregistered / invalid): revoke them. */
  invalidTokenIds: string[];
  /** Some tokens failed transiently (worth retrying when none was sent). */
  retryable: boolean;
  error: { code: string; message: string } | null;
}

export interface PushProvider {
  readonly name: string;
  send(message: PushMessage): Promise<PushResult>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<SendResult>;
  /** Releases pooled connections (shutdown). */
  close?(): void;
}

export interface SmsMessage {
  /** E.164, e.g. +919876543210. */
  to: string;
  text: string;
}

export interface SmsProvider {
  readonly name: string;
  send(message: SmsMessage): Promise<SendResult>;
}

/** Races a provider call against `ms`; a timeout is retryable. */
export const withTimeout = async <T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      resolve(onTimeout());
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** For logs only: m***@farmx.in, ******3210. */
export const maskEmail = (email: string): string => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
};
export const maskPhone = (phone: string): string => `******${phone.slice(-4)}`;
