import type { DocsOptions } from '@farmx/common/server';

import type { AuthConfig } from '../config/index.js';
import { ADMIN_ROLES_TAG } from '../features/access/index.js';
import { ADMIN_AUDIT_TAG } from '../features/audit/index.js';
import { ADMIN_USERS_TAG } from '../features/users/index.js';

/**
 * auth-service spec at `/api-docs.json`; the gateway merges it into the single Swagger UI at
 * `<gateway>/api-docs` (D-29). Sections are listed in display order.
 */
export const createDocsOptions = (config: AuthConfig): DocsOptions => ({
  title: 'FarmX Auth API',
  version: config.SERVICE_VERSION,
  description:
    'Identity and access: admin user management and the admin audit log. ' +
    'Every response uses the envelope `{ success, data, meta? }` or `{ success: false, error }`.',
  servers: [
    { url: config.DOCS_SERVER_LOCAL_URL, description: 'Local (through the gateway)' },
    ...(config.DOCS_SERVER_PROD_URL === undefined
      ? []
      : [{ url: config.DOCS_SERVER_PROD_URL, description: 'Production' }]),
  ],
  tags: [
    { name: 'Health', description: 'Public liveness and readiness probes.' },
    {
      name: 'Auth',
      description:
        'Login (customer OTP, admin password + MFA), token refresh, logout, password reset. Public except logout.',
    },
    { name: 'User', description: 'The logged-in user: profile, sessions, password, MFA.' },
    {
      name: ADMIN_USERS_TAG,
      description: 'Admin panel: manage users, roles, status and sessions.',
    },
    {
      name: ADMIN_ROLES_TAG,
      description: 'Admin panel: dynamic roles built from the fixed permission catalog.',
    },
    { name: ADMIN_AUDIT_TAG, description: 'Admin panel: append-only log of every admin change.' },
  ],
});
