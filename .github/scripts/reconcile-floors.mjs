#!/usr/bin/env node
/**
 * Reconcile documented runtime floors against what each SDK's own manifest
 * declares.
 *
 * This is the deterministic half's real job. There are no version pins to bump
 * anywhere in the docs (every install command is deliberately unpinned), but
 * there ARE eight prose claims about minimum runtime versions, and four of them
 * were wrong when this script was written:
 *
 *   quickstart/installation.mdx   "Node.js 16+, Python 3.8+, PHP 7.4+"
 *   sdks/python/send-with-flask   "Python 3.8 or later"   vs requires-python >=3.7
 *   sdks/python/send-with-fastapi "Python 3.8 or later"   vs requires-python >=3.7
 *   sdks/ruby/send-with-rails     "Ruby 3.0 or later"     vs gemspec >= 2.7.0
 *   sdks/nodejs/*                 "Node.js 16 or later"   vs NO engines field
 *   (go.mod declares go 1.23, documented nowhere)
 *
 *   node .github/scripts/reconcile-floors.mjs --sdk-roots <dir>            # report
 *   node .github/scripts/reconcile-floors.mjs --sdk node --fix --sdk-roots <dir>
 *
 * Classification:
 *   stale         claim is BELOW the declared floor. Blocking for the releasing
 *                 SDK, advisory for the others -- a Go release must never
 *                 silently rewrite Python prose.
 *   conservative  claim is ABOVE the declared floor. Always advisory: the Nuxt
 *                 page's "Node.js 18 or later" is legitimately Nuxt's own
 *                 requirement, not the SDK's, and no script can tell.
 *   unsourced     the SDK declares no floor at all. Always advisory, and the fix
 *                 belongs in the SDK (add an `engines` field), not in the docs.
 */

import { existsSync, readFileSync, writeFileSync, globSync } from 'node:fs';
import { join } from 'node:path';
import { SDKS, SDK_IDS, sdkOrDie } from './lib/sdk-registry.mjs';

function arg(name, dflt) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  const next = process.argv[process.argv.indexOf(hit) + 1];
  return next && !next.startsWith('--') ? next : true;
}

const DIRS = {
  node: 'sendlayer-node', python: 'sendlayer-python', php: 'sendlayer-php',
  ruby: 'sendlayer-ruby', go: 'sendlayer-go',
};

const roots = arg('sdk-roots');
const releasing = arg('sdk');
const fix = !!arg('fix');

/** Strip a semver range operator, keep the version. `>=3.7` -> `3.7` */
const bare = (v) => String(v || '').replace(/^[^\d]*/, '').trim();

/** Numeric compare on dotted versions. */
function cmp(a, b) {
  const pa = bare(a).split('.').map(Number);
  const pb = bare(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Read each SDK's declared floor from its own manifest. */
function declaredFloors() {
  const out = {};
  for (const id of SDK_IDS) {
    const sdk = SDKS[id];
    out[id] = { label: sdk.floor.label, declared: null };
    if (!roots) continue;
    const p = join(roots, DIRS[id], sdk.floor.path);
    if (!existsSync(p)) continue;
    try { out[id].declared = sdk.floor.read(readFileSync(p, 'utf8')); } catch { /* leave null */ }
  }
  return out;
}

// "Node.js 16 or later", "Python 3.8+", "Ruby 3.0 or later"
const claimRe = (label) => new RegExp(
  `\\b(${label.replace(/\./g, '\\.')})\\s+(\\d+(?:\\.\\d+)*)\\s*(\\+|or later)`, 'g');

const floors = declaredFloors();
const pages = globSync('{guides,quickstart,sdks}/**/*.mdx').sort();
const findings = [];

for (const page of pages) {
  const text = readFileSync(page, 'utf8');
  let updated = text;

  for (const [id, f] of Object.entries(floors)) {
    const re = claimRe(f.label);
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const [full, label, claimed, suffix] = m;
      const line = text.slice(0, m.index).split('\n').length;

      if (!f.declared) {
        findings.push({
          page, line, sdk: id, kind: 'unsourced', level: 'advisory', claimed, declared: null,
          message: `"${full}" has no manifest source — ${SDKS[id].repo} declares no floor ` +
                   `(${SDKS[id].floor.path}). Fix belongs in the SDK, not the docs.`,
        });
        continue;
      }

      const c = cmp(claimed, f.declared);
      if (c === 0) continue;

      if (c > 0) {
        findings.push({
          page, line, sdk: id, kind: 'conservative', level: 'advisory', claimed,
          declared: f.declared,
          message: `"${full}" is stricter than the declared floor ${f.declared}. ` +
                   'Likely a framework requirement rather than an SDK one; left alone.',
        });
        continue;
      }

      const level = id === releasing ? 'blocking' : 'advisory';
      findings.push({
        page, line, sdk: id, kind: 'stale', level, claimed, declared: f.declared,
        message: `"${full}" is below the declared floor ${f.declared} in ${SDKS[id].floor.path}`,
      });

      // Only ever rewrite the releasing SDK's own literals.
      if (fix && id === releasing) {
        const want = `${label} ${bare(f.declared)} ${suffix === '+' ? '+' : 'or later'}`
          .replace(' +', '+');
        updated = updated.split(full).join(want);
      }
    }
  }

  if (fix && updated !== text) {
    writeFileSync(page, updated);
    console.log(`rewrote floor claims in ${page}`);
  }
}

console.log('declared floors:');
for (const [id, f] of Object.entries(floors)) {
  console.log(`  ${id.padEnd(7)} ${String(f.label).padEnd(9)} ${f.declared ?? '(none declared)'}`);
}
console.log(`\n${findings.length} finding(s):`);
for (const f of findings) {
  console.log(`  ${f.level.padEnd(9)} ${f.kind.padEnd(13)} ${f.page}:${f.line}  ${f.message}`);
}

const blocking = findings.filter((f) => f.level === 'blocking');
if (arg('json')) writeFileSync(arg('json'), JSON.stringify({ floors, findings }, null, 2));
process.exit(blocking.length && !fix ? 1 : 0);
