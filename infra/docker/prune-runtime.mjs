// Docker build helper: slims a `pnpm deploy --prod` output for runtime.
//
//   node prune-runtime.mjs /prod/app
//
// pnpm 10 resolves OPTIONAL peer dependencies when they exist anywhere in the workspace, so
// @prisma/client drags in the `prisma` CLI (+ Prisma Studio, pglite, React, TypeScript ≈ 200 MB)
// even under --prod. Neither is ever loaded at runtime: the generated client only uses
// @prisma/client/runtime, and code is already compiled. This walks the real dependency graph from
// the service's dependencies (pnpm layout: a package's deps are the siblings in its
// .pnpm/<id>/node_modules dir), skips edges to SKIPPED, and deletes every unreachable .pnpm entry.
// Workspace packages (@farmx/*) are bundled into dist by tsup, so they are not roots either.
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const SKIPPED = new Set(['prisma', 'typescript']);

const app = process.argv[2];
if (app === undefined) throw new Error('usage: node prune-runtime.mjs <deploy dir>');
const nodeModules = join(app, 'node_modules');
const store = join(nodeModules, '.pnpm');
const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));

/** Names of the packages linked in a node_modules dir (handles @scope/name). */
const linked = (dir) =>
  readdirSync(dir)
    .filter((n) => n !== '.pnpm' && n !== '.bin' && !n.startsWith('.'))
    .flatMap((n) => (n.startsWith('@') ? readdirSync(join(dir, n)).map((s) => `${n}/${s}`) : [n]));

/** `.pnpm/<id>` entry that holds a real package path. */
const storeEntry = (real) => relative(store, real).split(sep)[0];

const visited = new Set();
const walk = (linkPath) => {
  if (!existsSync(linkPath)) return; // optional dependency not installed for this platform
  const real = realpathSync(linkPath);
  if (!real.startsWith(store)) return;
  const entry = storeEntry(real);
  if (visited.has(`${entry}|${real}`)) return;
  visited.add(`${entry}|${real}`);
  // The package's own node_modules dir: …/.pnpm/<id>/node_modules[/@scope]/<name>
  const depth = pkgNameOf(real).split('/').length;
  let siblingsDir = real;
  for (let i = 0; i < depth; i += 1) siblingsDir = dirname(siblingsDir);
  for (const dep of linked(siblingsDir)) {
    if (SKIPPED.has(dep)) continue;
    const target = join(siblingsDir, dep);
    if (target !== real) walk(target);
  }
};
const pkgNameOf = (real) => {
  const parts = real.split(sep);
  const i = parts.lastIndexOf('node_modules');
  const rest = parts.slice(i + 1);
  return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
};

const roots = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@farmx/'));
for (const dep of roots) walk(join(nodeModules, dep));

const keep = new Set([...visited].map((v) => v.split('|')[0]));
let removed = 0;
let bytes = 0;
const size = (p) => {
  const s = statSync(p, { throwIfNoEntry: false });
  if (s === undefined || s.isSymbolicLink()) return 0;
  if (!s.isDirectory()) return s.size;
  return readdirSync(p).reduce((sum, n) => sum + size(join(p, n)), 0);
};
for (const entry of readdirSync(store)) {
  if (entry === 'node_modules' || entry.startsWith('.') || keep.has(entry)) continue;
  bytes += size(join(store, entry));
  rmSync(join(store, entry), { recursive: true, force: true });
  removed += 1;
}
// Top-level links to removed / bundled packages.
for (const name of linked(nodeModules)) {
  const link = join(nodeModules, name);
  if (name.startsWith('@farmx/') || !existsSync(link)) rmSync(link, { recursive: true, force: true });
}
for (const scope of readdirSync(nodeModules).filter((n) => n.startsWith('@'))) {
  if (readdirSync(join(nodeModules, scope)).length === 0) rmSync(join(nodeModules, scope), { recursive: true });
}
console.log(
  `prune-runtime: kept ${String(keep.size)} packages, removed ${String(removed)} (${(bytes / 1e6).toFixed(0)} MB)`,
);
