/**
 * auth-service seed — idempotent and safe to run on every deploy.
 *
 * 1. Syncs the FIXED permission catalog (src/features/access/permissions.catalog.ts):
 *    upserts every key, marks keys removed from code as deprecated, restores re-added keys.
 * 2. Ensures the `super_admin` system role exists and holds every active permission.
 *    No other roles are seeded — roles are dynamic and created in the admin panel.
 * 3. Bootstraps the FIRST Super Admin user, only if no active super_admin assignment exists.
 *    Credentials come only from env vars; the password is never logged.
 *
 * Env:
 *   DATABASE_URL            required
 *   SEED_ADMIN_EMAIL        required for bootstrap
 *   SEED_ADMIN_PHONE        optional, E.164 (+919876543210)
 *   SEED_ADMIN_NAME         optional, default "Super Admin"
 *   SEED_ADMIN_PASSWORD     required for bootstrap; ≥14 chars, 3 of 4 character classes
 *   SEED_ALLOW_PRODUCTION   must be "true" to run with NODE_ENV=production
 *
 * Concurrent runs are serialised with a transaction-scoped Postgres advisory lock.
 */
import { createLogger } from '@farmx/common/logger';
import { closeDatabase, getDatabase } from '@farmx/database/client';
import argon2 from 'argon2';

import { PERMISSIONS, SUPER_ADMIN_ROLE } from '../src/features/access/permissions.catalog.js';

/** Actor recorded in audit rows written by the seed itself. */
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const ADVISORY_LOCK_KEY = 'farmx-auth-seed';

/** OWASP minimum for Argon2id. The login code must use the same (or stronger) parameters. */
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

const COMMON_PASSWORDS = new Set([
  'password',
  'password123',
  'admin',
  'admin123',
  'administrator',
  'welcome',
  'qwerty',
  'letmein',
  'changeme',
  'farmx',
  'farmxadmin',
  'superadmin',
  '123456789',
]);

class SeedError extends Error {}

const log = (message: string): void => {
  process.stdout.write(`[seed] ${message}\n`);
};

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function assertEnvironmentAllowed(): void {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PRODUCTION !== 'true') {
    throw new SeedError(
      'Refusing to seed with NODE_ENV=production. Set SEED_ALLOW_PRODUCTION=true to override.',
    );
  }
}

interface AdminInput {
  email: string;
  phone: string | null;
  fullName: string;
  password: string;
}

function readAdminInput(): AdminInput | null {
  const email = readEnv('SEED_ADMIN_EMAIL')?.toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (email === undefined && (password === undefined || password === '')) return null;
  if (email === undefined)
    throw new SeedError('SEED_ADMIN_EMAIL is required when SEED_ADMIN_PASSWORD is set.');
  if (password === undefined || password === '') {
    throw new SeedError('SEED_ADMIN_PASSWORD is required when SEED_ADMIN_EMAIL is set.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new SeedError('SEED_ADMIN_EMAIL is not a valid email.');

  const phone = readEnv('SEED_ADMIN_PHONE') ?? null;
  if (phone !== null && !/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new SeedError('SEED_ADMIN_PHONE must be E.164, e.g. +919876543210.');
  }

  assertStrongPassword(password, [email, email.split('@')[0] ?? '', phone ?? '']);
  return { email, phone, fullName: readEnv('SEED_ADMIN_NAME') ?? 'Super Admin', password };
}

function assertStrongPassword(password: string, personal: string[]): void {
  const problems: string[] = [];
  if (password.length < 14) problems.push('at least 14 characters');
  if (password.length > 128) problems.push('at most 128 characters');
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) problems.push('3 of: lowercase, uppercase, digit, symbol');
  const lowered = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lowered.replace(/[^a-z0-9]/g, '')))
    problems.push('not a common password');
  for (const value of personal) {
    const part = value.toLowerCase().replace(/^\+/, '');
    if (part.length >= 4 && lowered.includes(part))
      problems.push('must not contain the email or phone');
  }
  if (problems.length > 0) {
    throw new SeedError(`SEED_ADMIN_PASSWORD is too weak (${[...new Set(problems)].join('; ')}).`);
  }
}

async function main(): Promise<void> {
  assertEnvironmentAllowed();
  const databaseUrl = readEnv('DATABASE_URL');
  if (databaseUrl === undefined) throw new SeedError('DATABASE_URL is not set.');

  const admin = readAdminInput();
  // Hash outside the transaction: it is deliberately slow.
  const passwordHash = admin === null ? null : await argon2.hash(admin.password, ARGON2_OPTIONS);

  // Shared singleton client (@farmx/database); a small pool is enough for the seed.
  const prisma = getDatabase({
    url: databaseUrl,
    logger: createLogger({ service: 'auth-seed', level: 'warn' }),
    poolSize: 2,
  });
  try {
    await prisma.$transaction(
      async (tx) => {
        // $executeRaw: the function returns `void`, which $queryRaw cannot deserialize.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ADVISORY_LOCK_KEY}))`;
        const now = new Date();

        // ── 1. Sync the fixed permission catalog ──
        for (const permission of PERMISSIONS) {
          const data = {
            module: permission.module,
            action: permission.action,
            description: permission.description,
            isSensitive: permission.isSensitive,
            assignable: permission.assignable,
            allowedScopes: permission.allowedScopes,
            sortOrder: permission.sortOrder,
            deprecatedAt: null,
          };
          await tx.permission.upsert({
            where: { key: permission.key },
            create: { key: permission.key, ...data },
            update: data,
          });
        }
        const deprecated = await tx.permission.updateMany({
          where: { key: { notIn: PERMISSIONS.map((p) => p.key) }, deprecatedAt: null },
          data: { deprecatedAt: now },
        });
        log(
          `permissions synced: ${PERMISSIONS.length} active, ${deprecated.count} newly deprecated`,
        );

        // ── 2. super_admin system role holds every active permission ──
        const { key, ...roleData } = SUPER_ADMIN_ROLE;
        const role = await tx.role.upsert({
          where: { key },
          create: { key, ...roleData },
          update: { ...roleData, archivedAt: null },
        });
        const active = await tx.permission.findMany({
          where: { deprecatedAt: null },
          select: { id: true },
        });
        const granted = await tx.rolePermission.createMany({
          data: active.map((p) => ({ roleId: role.id, permissionId: p.id })),
          skipDuplicates: true,
        });
        if (deprecated.count > 0 || granted.count > 0) {
          await tx.adminAuditLog.create({
            data: {
              actorUserId: SYSTEM_ACTOR_ID,
              action: 'permissions.synced',
              targetType: 'role',
              targetId: role.id,
              after: {
                granted: granted.count,
                deprecated: deprecated.count,
                total: PERMISSIONS.length,
              },
              reason: 'seed: permission catalog sync',
            },
          });
        }
        log(`role super_admin ready (${granted.count} permission grants added)`);

        // ── 3. Bootstrap the first Super Admin (never duplicates, never overwrites) ──
        const existing = await tx.userRole.findFirst({
          where: {
            roleId: role.id,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          select: { id: true },
        });
        if (existing !== null) {
          log('super admin: skipped (an active super_admin assignment already exists)');
          return;
        }
        if (admin === null || passwordHash === null) {
          log(
            'super admin: skipped (no active super_admin and SEED_ADMIN_* not set) — set them to bootstrap',
          );
          return;
        }

        const clash = await tx.user.findFirst({
          where: {
            OR: [{ email: admin.email }, ...(admin.phone === null ? [] : [{ phone: admin.phone }])],
          },
          select: { id: true },
        });
        if (clash !== null) {
          throw new SeedError(
            'SEED_ADMIN_EMAIL/PHONE already belongs to an existing user. Refusing to escalate an existing account; ' +
              'grant super_admin to it from an authorised session instead.',
          );
        }

        const user = await tx.user.create({
          data: {
            userType: 'INTERNAL',
            email: admin.email,
            emailVerifiedAt: now,
            phone: admin.phone,
            phoneVerifiedAt: admin.phone === null ? null : now,
            fullName: admin.fullName,
            status: 'ACTIVE',
            statusChangedAt: now,
            mfaRequired: true,
            mustChangePassword: true,
            registrationSource: 'seed',
          },
          select: { id: true },
        });
        // No cross-module relations: credential rows are linked by plain userId.
        await tx.credential.create({ data: { userId: user.id, passwordHash } });
        await tx.passwordHistory.create({ data: { userId: user.id, passwordHash } });
        const assignment = await tx.userRole.create({
          data: {
            userId: user.id,
            roleId: role.id,
            scopeType: 'GLOBAL',
            assignedByUserId: user.id,
            reason: 'bootstrap',
          },
          select: { id: true },
        });
        await tx.adminAuditLog.create({
          data: {
            actorUserId: user.id,
            action: 'user_role.assigned',
            targetType: 'user_role',
            targetId: assignment.id,
            subjectUserId: user.id,
            after: { role: SUPER_ADMIN_ROLE.key, scopeType: 'GLOBAL' },
            reason: 'bootstrap',
          },
        });
        await tx.authEvent.create({
          data: {
            userId: user.id,
            type: 'STATUS_CHANGED',
            success: true,
            reason: 'seed_bootstrap',
          },
        });
        log('super admin: created (must change password and enrol MFA at first login)');
      },
      { timeout: 60_000, maxWait: 30_000 },
    );
  } finally {
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof SeedError ? error.message : 'unexpected error (see stack below)';
  process.stderr.write(`[seed] FAILED: ${message}\n`);
  if (!(error instanceof SeedError))
    process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`);
  process.exitCode = 1;
});
