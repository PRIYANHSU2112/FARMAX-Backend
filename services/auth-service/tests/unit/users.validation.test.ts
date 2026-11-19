import { describe, expect, it } from 'vitest';

import {
  setRolesSchema,
  createUserSchema,
  listUsersSchema,
} from '../../src/features/users/users.validation.js';

const opts = { abortEarly: false, stripUnknown: true, convert: true } as const;

describe('users validators', () => {
  it('create: requires email or phone', () => {
    const { error } = createUserSchema.body.validate(
      { userType: 'INTERNAL', fullName: 'Ravi' },
      opts,
    );
    expect(error?.message).toContain('email or phone is required');
  });

  it('create: lower-cases email and rejects a non-E.164 phone', () => {
    const ok = createUserSchema.body.validate(
      { userType: 'INTERNAL', fullName: 'Ravi', email: 'Ravi@FarmX.in' },
      opts,
    );
    expect(ok.error).toBeUndefined();
    expect((ok.value as { email: string }).email).toBe('ravi@farmx.in');

    const bad = createUserSchema.body.validate(
      { userType: 'INTERNAL', fullName: 'Ravi', phone: '9876543210' },
      opts,
    );
    expect(bad.error?.message).toContain('E.164');
  });

  it('roles: scopeId required for WAREHOUSE and forbidden for GLOBAL; defaults GLOBAL', () => {
    const missing = setRolesSchema.body.validate(
      { roles: [{ roleKey: 'warehouse_manager', scopeType: 'WAREHOUSE' }], reason: 'abc' },
      opts,
    );
    expect(missing.error).toBeDefined();

    const extra = setRolesSchema.body.validate(
      {
        roles: [
          {
            roleKey: 'warehouse_manager',
            scopeType: 'GLOBAL',
            scopeId: '01900000-0000-7000-8000-000000000001',
          },
        ],
        reason: 'abc',
      },
      opts,
    );
    expect(extra.error).toBeDefined();

    const ok = setRolesSchema.body.validate(
      { roles: [{ roleKey: 'warehouse_manager' }], reason: 'abc' },
      opts,
    );
    expect(ok.error).toBeUndefined();
    expect(ok.value as unknown).toMatchObject({ roles: [{ scopeType: 'GLOBAL', scopeId: null }] });

    const empty = setRolesSchema.body.validate({ roles: [], reason: 'remove all' }, opts);
    expect(empty.error).toBeUndefined();
  });

  it('list: applies defaults and converts query strings', () => {
    const result = listUsersSchema.querystring.validate(
      { includeDeleted: 'true', limit: '5' },
      opts,
    );
    expect(result.error).toBeUndefined();
    expect(result.value as unknown).toEqual({ includeDeleted: true, limit: 5 });
    expect(listUsersSchema.querystring.validate({ limit: 500 }, opts).error).toBeDefined();
  });
});
