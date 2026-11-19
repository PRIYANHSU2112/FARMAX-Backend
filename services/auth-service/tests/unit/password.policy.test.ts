import { describe, expect, it } from 'vitest';

import { passwordProblems } from '../../src/features/auth/password.policy.js';

describe('passwordProblems', () => {
  it('accepts a long password with 3 character classes', () => {
    expect(passwordProblems('Harvest-Moon-2026', ['ravi@farmx.in'])).toEqual([]);
  });

  it('rejects short, single-class, common and personal passwords', () => {
    expect(passwordProblems('Short1!', [])).toContain('at least 12 characters');
    expect(passwordProblems('alllowercaseletters', [])).toContain(
      '3 of: lowercase, uppercase, digit, symbol',
    );
    expect(passwordProblems('Password123', []).join()).toContain('common');
    expect(passwordProblems('Ravikumar-2026!', ['ravikumar']).join()).toContain('must not contain');
  });
});
