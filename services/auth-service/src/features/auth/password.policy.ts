import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './auth.types.js';

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

/**
 * Returns the policy problems of a password (empty = acceptable).
 * `personal` = the user's identifiers (email, its local part, phone, username).
 */
export function passwordProblems(password: string, personal: readonly string[]): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH)
    problems.push(`at least ${PASSWORD_MIN_LENGTH} characters`);
  if (password.length > PASSWORD_MAX_LENGTH)
    problems.push(`at most ${PASSWORD_MAX_LENGTH} characters`);
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) problems.push('3 of: lowercase, uppercase, digit, symbol');
  const lowered = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lowered.replace(/[^a-z0-9]/g, '')))
    problems.push('not a common password');
  for (const value of personal) {
    const part = value.toLowerCase().replace(/^\+/, '');
    if (part.length >= 4 && lowered.includes(part)) {
      problems.push('must not contain your email, phone or username');
      break;
    }
  }
  return problems;
}
