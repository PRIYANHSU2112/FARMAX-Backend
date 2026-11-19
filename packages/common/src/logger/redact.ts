/** Object keys whose values must never reach the logs, at any of the first 3 levels. */
const SENSITIVE_KEYS = [
  'password',
  'passwordHash',
  'newPassword',
  'currentPassword',
  'temporaryPassword',
  'recoveryCode',
  'recoveryCodes',
  'otpauthUrl',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'apiKey',
  'otp',
  'cardNumber',
  'cvv',
] as const;

const HTTP_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-internal-token"]',
  'req.headers["x-razorpay-signature"]',
  'res.headers["set-cookie"]',
];

export const DEFAULT_REDACT_PATHS: readonly string[] = [
  ...HTTP_PATHS,
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

export const REDACT_CENSOR = '[REDACTED]';
