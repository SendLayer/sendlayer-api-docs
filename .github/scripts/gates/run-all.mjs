#!/usr/bin/env node
/**
 * Gate orchestrator. Runs cheapest-first and writes gate-report.json plus a
 * markdown block for the PR body.
 *
 *   node .github/scripts/gates/run-all.mjs --stage=agent  --context <ctx.json>
 *   node .github/scripts/gates/run-all.mjs --stage=final  --context <ctx.json>
 *
 * --stage=agent  everything the agent can act on.
 * --stage=final  adds changelog-render; the authoritative pass. The agent's own
 *                self-report is never trusted as the gate result.
 *
 * Exit 0 when no blocking findings, 1 otherwise. Advisory findings never fail.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function arg(name, dflt) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  const next = process.argv[process.argv.indexOf(hit) + 1];
  return next && !next.startsWith('--') ? next : true;
}

const stage = arg('stage', 'agent');
const ctxPath = arg('context');
const ctx = ctxPath && existsSync(ctxPath) ? JSON.parse(readFileSync(ctxPath, 'utf8')) : {};
const baseRef = arg('base', ctx.baseRef || 'HEAD');
const sdkId = arg('sdk', ctx.sdk);
const sdkRoot = arg('sdk-root', ctx.sdkRoot);
// Never default into the repo root: a report file written beside the docs
// registers as a scope violation on the next run.
const reportPath = arg('report', ctx.reportPath
  || (ctxPath ? ctxPath.replace(/[^/]+$/, 'gate-report.json')
              : join(tmpdir(), 'sl-gate-report.json')));

const changed = (() => {
  const out = new Set();
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8' });
  for (const l of git('status', '--porcelain').split('\n')) {
    if (l.trim()) out.add(l.slice(3).split(' -> ').pop().replace(/^"|"$/g, ''));
  }
  for (const l of git('diff', '--name-only', baseRef).split('\n')) if (l.trim()) out.add(l.trim());
  return [...out];
})();

const files = ctx.allowlist?.length ? changed.filter((f) => ctx.allowlist.includes(f)) : changed;

const ORDER = [
  ['scope', () => import('./scope.mjs'),
    () => ({ allowlist: ctx.allowlist, baseRef, ignore: ctx.ignore ?? [] })],
  ['frontmatter', () => import('./frontmatter.mjs'), () => ({ files, baseRef })],
  ['mdx-parse', () => import('./mdx-parse.mjs'), () => ({ files })],
  ['fence', () => import('./fence.mjs'), () => ({ files, sdk: sdkId, baseRef })],
  ['symbol', () => import('./symbol.mjs'), () => ({ files, sdk: sdkId, sdkRoot, baseRef })],
  ['placeholder', () => import('./placeholder.mjs'), () => ({ files, baseRef })],
  ['nav', () => import('./nav.mjs'), () => ({})],
  ['link', () => import('./link.mjs'), () => ({ files })],
  ['snippets', () => import('./snippets.mjs'), () => ({ files, sdk: sdkId })],
  ['vale', () => import('./vale.mjs'), () => ({ files, baseRef })],
];

if (stage === 'final') {
  ORDER.push(['changelog-render', () => import('./changelog-render.mjs'),
    () => ({ context: ctxPath, summary: ctx.summaryPath, baseRef })]);
}

const findings = [];
const ran = [];

for (const [name, load, argsFor] of ORDER) {
  if (!changed.length && name !== 'nav') { ran.push({ name, skipped: 'no changes' }); continue; }
  let mod;
  try { mod = await load(); }
  catch (e) {
    findings.push({ gate: name, path: '.', level: 'blocking', message: `gate failed to load: ${e.message}` });
    continue;
  }
  try {
    const res = await mod.run(argsFor());
    findings.push(...res);
    ran.push({ name, findings: res.length });
  } catch (e) {
    findings.push({ gate: name, path: '.', level: 'blocking', message: `gate threw: ${e.message}` });
    ran.push({ name, error: e.message });
  }
}

const blocking = findings.filter((f) => f.level === 'blocking');
const advisory = findings.filter((f) => f.level !== 'blocking');

writeFileSync(reportPath, JSON.stringify({
  stage, sdk: sdkId, baseRef, changedFiles: changed,
  gatesRun: ran, blocking, advisory,
  ok: blocking.length === 0,
}, null, 2));

const md = [];
md.push(`### Gate report (${stage})`, '');
md.push(`- files changed: ${changed.length}`);
md.push(`- blocking: **${blocking.length}**`);
md.push(`- advisory: ${advisory.length}`, '');
if (blocking.length) {
  md.push('#### Blocking', '');
  for (const f of blocking) md.push(`- \`${f.path}\` **[${f.gate}]** ${f.message}`);
  md.push('');
}
if (advisory.length) {
  md.push('<details><summary>Advisory findings</summary>', '');
  for (const f of advisory) md.push(`- \`${f.path}\` [${f.gate}] ${f.message}`);
  md.push('', '</details>');
}
writeFileSync(reportPath.replace(/\.json$/, '.md'), md.join('\n'));

console.log(md.join('\n'));
console.log(`\nreport: ${reportPath}`);
process.exit(blocking.length ? 1 : 0);
