import { describe, expect, it } from 'vitest';

import { AUTH_EVENTS, EVENT_TYPE_PATTERN } from '../index.js';

describe('auth event contracts', () => {
  it('uses <aggregate>.<event>.v<N> routing keys', () => {
    for (const type of Object.values(AUTH_EVENTS)) expect(type).toMatch(EVENT_TYPE_PATTERN);
  });

  it('has unique routing keys', () => {
    const types = Object.values(AUTH_EVENTS);
    expect(new Set(types).size).toBe(types.length);
  });

  it('rejects malformed routing keys', () => {
    for (const bad of ['user.registered', 'User.Registered.v1', 'user.registered.v0', 'a.b.c.v1']) {
      expect(bad).not.toMatch(EVENT_TYPE_PATTERN);
    }
  });
});
