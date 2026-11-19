import type { UserType } from '@farmx/common/types';

/** Password policy for passwords set by admins or users (the seed uses a stricter 14). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
/** Reuse of the last N passwords is refused. */
export const PASSWORD_HISTORY_SIZE = 5;

/** OWASP minimum for Argon2id; must match scripts/seed.ts. */
export const ARGON2_PARAMS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** Durable lockout (credentials table): N consecutive failures lock the account for M minutes. */
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MINUTES = 15;

/** OTP: 6 digits, 5 minutes, 5 attempts, 30 s resend cooldown. */
export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 300;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 30;
export type OtpPurpose = 'login' | 'pwd_reset';

/** MFA login challenge: 5 minutes, 5 attempts. TOTP: 30 s steps, ±1 step tolerance. */
export const MFA_CHALLENGE_TTL_SECONDS = 300;
export const MFA_MAX_ATTEMPTS = 5;
export const TOTP_STEP_SECONDS = 30;
export const TOTP_WINDOW = 1;
export const RECOVERY_CODE_COUNT = 10;

export type DevicePlatform = 'ANDROID' | 'IOS' | 'WEB' | 'DESKTOP' | 'OTHER';
export const DEVICE_PLATFORMS: readonly DevicePlatform[] = [
  'ANDROID',
  'IOS',
  'WEB',
  'DESKTOP',
  'OTHER',
];

/** Mirrors the Prisma enum `AuthEventType` (the values used by this service). */
export type AuthEventType =
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILED'
  | 'LOGOUT'
  | 'LOGOUT_ALL'
  | 'OTP_SENT'
  | 'OTP_VERIFIED'
  | 'OTP_FAILED'
  | 'OTP_RATE_LIMITED'
  | 'TOKEN_REFRESHED'
  | 'TOKEN_REUSE_DETECTED'
  | 'SESSION_REVOKED'
  | 'PASSWORD_CHANGED'
  | 'PASSWORD_RESET_REQUESTED'
  | 'PASSWORD_RESET'
  | 'MFA_ENROLLED'
  | 'MFA_REMOVED'
  | 'MFA_SUCCESS'
  | 'MFA_FAILED'
  | 'ACCOUNT_LOCKED'
  | 'NEW_DEVICE'
  | 'DEVICE_LOGIN_BLOCKED';

/** Where a request came from (for sessions, devices and auth events). */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  /** Client-generated stable device id (app install id / browser id). Hashed before storage. */
  deviceId?: string;
  deviceName?: string;
  platform?: DevicePlatform;
}

export interface AuthUserSummary {
  id: string;
  userType: UserType;
  fullName: string;
  roles: string[];
  mustChangePassword: boolean;
}

/** Tokens returned by every successful login / refresh. */
export interface AuthTokens {
  status: 'authenticated';
  tokenType: 'Bearer';
  accessToken: string;
  /** Seconds. */
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: string;
  isNewUser?: boolean;
  user: AuthUserSummary;
}

export interface MfaChallengeResponse {
  status: 'mfa_required';
  challengeId: string;
  methods: ('totp' | 'recovery_code')[];
  expiresIn: number;
}

/** MFA is mandatory but not set up: an enrolment-only access token (no refresh token). */
export interface MfaEnrollmentResponse {
  status: 'mfa_enrollment_required';
  tokenType: 'Bearer';
  accessToken: string;
  expiresIn: number;
  user: AuthUserSummary;
}

export type AdminLoginResult = AuthTokens | MfaChallengeResponse | MfaEnrollmentResponse;

export interface OtpSendResult {
  sent: true;
  expiresIn: number;
  resendAfter: number;
}

export interface TotpEnrollment {
  /** Base32 secret, shown once for manual entry. */
  secret: string;
  otpauthUrl: string;
}

export interface TotpConfirmResult {
  /** Shown ONCE. Each code works one time. */
  recoveryCodes: string[];
  /** Present when the caller used an enrolment-only token: full tokens for the new session. */
  tokens?: AuthTokens;
}
