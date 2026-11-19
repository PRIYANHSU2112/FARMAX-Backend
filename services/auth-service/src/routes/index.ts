import type { ServiceModule } from '@farmx/common/server';

import { accessInternalModule, accessModule } from '../features/access/index.js';
import { auditModule } from '../features/audit/index.js';
import { authModule } from '../features/auth/index.js';
import { sessionsModule } from '../features/sessions/index.js';
import { tokensModule } from '../features/tokens/index.js';
import { meModule, usersModule } from '../features/users/index.js';

/**
 * Every feature of auth-service, mounted by `buildService` (no service-level prefix; the gateway
 * maps `/v1/auth/*` → `/*`). Health routes (`/health/live`, `/health/ready`) come from
 * @farmx/common/server.
 *   /auth/*                 auth (login, refresh, logout, passwords) · /me/mfa/*  auth
 *   /me · /me/sessions      users (me), sessions
 *   /admin/users            users · /admin/roles, /admin/permissions  access
 *   /admin/audit-logs       audit · /.well-known/jwks.json  tokens
 */
export const features: readonly ServiceModule[] = [
  tokensModule,
  authModule,
  sessionsModule,
  meModule,
  usersModule,
  accessModule,
  accessInternalModule,
  auditModule,
];
