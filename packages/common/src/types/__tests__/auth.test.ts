import { describe, expectTypeOf, it } from 'vitest';

import type { AuthUser, SessionId, UserId } from '../index.js';

describe('AuthUser', () => {
  it('carries dynamic role keys and token metadata', () => {
    const user: AuthUser = {
      id: 'u-1' as UserId,
      sessionId: 's-1' as SessionId,
      jti: 'j-1',
      userType: 'INTERNAL',
      roles: ['super_admin'],
      scope: 'full',
      expiresAt: 1,
    };
    expectTypeOf(user.roles).toEqualTypeOf<readonly string[]>();
  });
});
