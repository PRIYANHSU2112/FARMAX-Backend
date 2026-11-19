import { randomUUID } from 'node:crypto';

import { ServiceUnavailableError } from '@farmx/common/errors';

/** Aadhaar OTP e-KYC (UIDAI via a licensed provider). The number is passed through, never kept. */
export interface AadhaarProvider {
  sendOtp(aadhaarNumber: string): Promise<{ txnRef: string }>;
  /** `null` = wrong or expired OTP. */
  verifyOtp(txnRef: string, otp: string): Promise<{ refId: string; name: string } | null>;
}

export interface GstRecord {
  gstin: string;
  legalName: string;
  tradeName: string | null;
  status: 'ACTIVE' | 'CANCELLED' | 'SUSPENDED' | 'INACTIVE';
  stateCode: string;
}

export interface GstProvider {
  readonly name: string;
  /** `null` = GSTIN not found on the portal. */
  lookup(gstin: string): Promise<GstRecord | null>;
}

/** Hard timeout + simple circuit breaker (opens after 5 straight failures for 30 s). */
export class Guarded {
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly label: string,
    private readonly timeoutMs = 3_000,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (Date.now() < this.openUntil) {
      throw new ServiceUnavailableError(`${this.label} is unavailable, try again shortly`);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`${this.label} timed out`));
          }, this.timeoutMs);
        }),
      ]);
      this.failures = 0;
      return result;
    } catch (cause) {
      this.failures += 1;
      if (this.failures >= 5) this.openUntil = Date.now() + 30_000;
      throw new ServiceUnavailableError(`${this.label} is unavailable, try again shortly`, {
        cause,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Local/test stub: OTP `123456` succeeds; the verified name is "Verified Owner". */
export class FakeAadhaarProvider implements AadhaarProvider {
  sendOtp(): Promise<{ txnRef: string }> {
    return Promise.resolve({ txnRef: randomUUID() });
  }

  verifyOtp(_txnRef: string, otp: string): Promise<{ refId: string; name: string } | null> {
    return Promise.resolve(
      otp === '123456' ? { refId: `FAKE-${randomUUID()}`, name: 'Verified Owner' } : null,
    );
  }
}

/** Local/test stub: any valid GSTIN is ACTIVE, except a PAN part starting `ZZZZZ` (CANCELLED). */
export class FakeGstProvider implements GstProvider {
  readonly name = 'fake';

  lookup(gstin: string): Promise<GstRecord | null> {
    return Promise.resolve({
      gstin,
      legalName: 'Registered Legal Name',
      tradeName: 'Registered Trade Name',
      status: gstin.slice(2, 7) === 'ZZZZZ' ? 'CANCELLED' : 'ACTIVE',
      stateCode: gstin.slice(0, 2),
    });
  }
}
