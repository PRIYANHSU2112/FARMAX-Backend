import { readdirSync } from 'node:fs';

/** Workspace folder names become the allowed commit scopes. */
const dirs = (rel) =>
  readdirSync(new URL(rel, import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

const scopes = [
  ...dirs('./packages/'),
  ...dirs('./services/'),
  'root',
  'infra',
  'deps',
  'plan',
  'ci',
  'release',
];

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [2, 'always', scopes],
    'scope-empty': [1, 'never'],
  },
};
