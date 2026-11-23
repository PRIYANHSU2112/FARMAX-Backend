import { ValidationError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';
import argon2 from 'argon2';

import {
  ARGON2_PARAMS,
  LOCKOUT_MINUTES,
  LOCKOUT_THRESHOLD,
  PASSWORD_HISTORY_SIZE,
} from './auth.types.js';
import { passwordProblems } from './password.policy.js';

export type PasswordCheck =
  | { ok: true }
  | { ok: false; reason: 'no_credential' | 'locked' | 'bad_password'; lockedUntil?: Date | null };

const ARGON2_OPTIONS = { type: argon2.argon2id, ...ARGON2_PARAMS };

/** Verified against when the user is unknown, so timing does not reveal which accounts exist. */
let dummyHash: Promise<string> | undefined;
const getDummyHash = (): Promise<string> =>
  (dummyHash ??= argon2.hash('farmx-dummy-password-for-timing', ARGON2_OPTIONS));

/**
 * Public API: passwords (Argon2id), lockout and history. No dependency on other features, so
 * `users` can use it for admin-provisioned passwords without a dependency cycle.
 */
export class CredentialsService {
  private readonly authRepository: Cradle['authRepository'];

  constructor({ authRepository }: Pick<Cradle, 'authRepository'>) {
    this.authRepository = authRepository;
  }

  /**
   * Checks the policy and returns an Argon2id hash. Call it BEFORE opening a transaction:
   * hashing is deliberately slow. Throws 422 with `body.<field>` issues on a weak password.
   */
  async hashNewPassword(
    password: string,
    personal: readonly string[],
    field = 'password',
  ): Promise<string> {
    const problems = passwordProblems(password, personal);
    if (problems.length > 0) {
      throw new ValidationError([
        { path: `body.${field}`, message: `Password needs: ${problems.join('; ')}` },
      ]);
    }
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  /** Stores the first password of a new user (credential + password history). */
  storeInitialPassword(userId: string, passwordHash: string, tx?: Tx): Promise<void> {
    return this.authRepository.createCredential(userId, passwordHash, tx);
  }

  /**
   * Password check with durable lockout. Unknown users still cost one Argon2 verify (timing).
   * A locked account is refused without verifying; failures are counted atomically.
   */
  async verifyPassword(userId: string | null, password: string): Promise<PasswordCheck> {
    if (userId === null) {
      await argon2.verify(await getDummyHash(), password);
      return { ok: false, reason: 'bad_password' };
    }
    const credential = await this.authRepository.findCredential(userId);
    if (credential === null) {
      await argon2.verify(await getDummyHash(), password);
      return { ok: false, reason: 'no_credential' };
    }
    const now = new Date();
    if (credential.lockedUntil !== null && credential.lockedUntil > now) {
      return { ok: false, reason: 'locked', lockedUntil: credential.lockedUntil };
    }
    if (!(await argon2.verify(credential.passwordHash, password))) {
      const lockedUntil = await this.authRepository.registerFailedLogin(
        userId,
        now,
        LOCKOUT_THRESHOLD,
        LOCKOUT_MINUTES,
      );
      return { ok: false, reason: lockedUntil === null ? 'bad_password' : 'locked', lockedUntil };
    }
    if (credential.failedLoginCount > 0 || credential.lockedUntil !== null) {
      await this.authRepository.clearFailedLogins(userId);
    }
    return { ok: true };
  }

  /** 422 when the new password equals one of the last N (checked in parallel). */
  async assertNotReused(userId: string, password: string, field = 'newPassword'): Promise<void> {
    const hashes = await this.authRepository.recentPasswordHashes(userId, PASSWORD_HISTORY_SIZE);
    const matches = await Promise.all(hashes.map((hash) => argon2.verify(hash, password)));
    if (matches.some(Boolean)) {
      throw new ValidationError([
        {
          path: `body.${field}`,
          message: `Must differ from your last ${PASSWORD_HISTORY_SIZE} passwords`,
        },
      ]);
    }
  }

  /** Replaces the password (hash from `hashNewPassword`), clears lockout, appends history. */
  setPassword(userId: string, passwordHash: string, tx: Tx): Promise<void> {
    return this.authRepository.setPassword(userId, passwordHash, tx);
  }

  /** Accepting an invitation: creates the credential, or replaces one left by an earlier setup. */
  setInvitedPassword(userId: string, passwordHash: string, tx: Tx): Promise<void> {
    return this.authRepository.upsertPassword(userId, passwordHash, tx);
  }
}
