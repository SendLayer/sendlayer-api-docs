#!/usr/bin/env node
/**
 * Gathers everything about one SDK release, classifies it, and writes the work
 * order the agent must follow. Runs BEFORE the agent, so scope is
 * machine-decided; injected prose cannot add a file to the allowlist.
 *
 *   node .github/scripts/release-context.mjs \
 *     --sdk go --version 1.0.0 --out "$RUNNER_TEMP/release" \
 *     [--prev-tag v0.1.1] [--sdk-root <path>] [--offline]
 *
 * Writes:
 *   <out>/context.json        tier, signals, allowlist, budget
 *   <out>/tasks.md            per-file work order fed to the agent
 *   <out>/compare.diff        full unified diff, for Grep/Read on demand
 *   <out>/untrusted/*.md      release body, PR bodies, SDK changelog -- DATA
 *
 * Enrichment priority for prose is CHANGELOG.md section > linked PR bodies >
 * release body. `generate_release_notes` bodies are PR-title lists (one real Go
 * PR title is literally "Develop"), while the PR body is where a human
 * explained what happened.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, globSync } from 'node:fs';
import { join } from 'node:path';
import { sdkOrDie, BUDGET } from './lib/sdk-registry.mjs';
import { classify, semverBump, allowlistFor } from './lib/classify.mjs';
import { parseFences, ownerOf } from './lib/mdx.mjs';

function arg(name, dflt) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  const next = process.argv[process.argv.indexOf(hit) + 1];
  return next && !next.startsWith('--') ? next : true;
}

const sdkId = arg('sdk');
const version = String(arg('version') || '').replace(/^v/, '');
const out = arg('out') || '.release';
const offline = !!arg('offline');
const sdk = sdkOrDie(sdkId);
const tag = `v${version}`;

mkdirSync(join(out, 'untrusted'), { recursive: true });

const gh = (args, dflt = '') => {
  if (offline) return dflt;
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return dflt;
  }
};

/* ------------------------------------------------------------------ *
 * Untrusted text sanitiser.
 * Defence in depth ONLY. The real containment is the agent's tool policy and
 * the machine-decided allowlist. A filter is a filter; do not oversell it.
 * ------------------------------------------------------------------ */
function sanitise(text) {
  return String(text || '')
    .replace(/^\s*#{0,6}\s*(system|assistant|human|user|developer)\s*:/gim, '[redacted: role-marker]')
    .replace(/<\/?(system-reminder|antml)[^>]*>/gi, '[redacted: control-tag]')
    .replace(/\bignore (all )?(previous|prior|above)\b/gi, '[redacted: override-attempt]')
    .replace(/\bdisregard (the )?(above|previous)\b/gi, '[redacted: override-attempt]')
    .replace(/^```(system|xml)\s*$/gim, '```text');
}

/** Minimal glob matcher shared by the surface checks. */
function matchGlob(glob, p) {
  const SLASH = '';
  const ANY = '';
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, SLASH)
    .replace(/\*\*/g, ANY)
    .replace(/\*/g, '[^/]*')
    .split(SLASH).join('(?:.*/)?')
    .split(ANY).join('.*');
  return new RegExp(`^${body}$`).test(p);
}

/* ---------------- release metadata ---------------- */
const relRaw = gh(['release', 'view', tag, '--repo', sdk.repo,
  '--json', 'tagName,name,body,publishedAt,isPrerelease,isDraft,url'], '{}');
let release = {};
try { release = JSON.parse(relRaw); } catch { release = {}; }
release.isPrerelease = release.isPrerelease ?? false;
release.draft = release.isDraft ?? false;
if (!release.publishedAt) release.publishedAt = arg('published-at') || new Date().toISOString();
writeFileSync(join(out, 'untrusted', 'release-body.md'), sanitise(release.body || ''));

/* ---------------- previous tag ---------------- */
let prevTag = arg('prev-tag') || '';
if (!prevTag && !offline) {
  const tags = gh(['api', `repos/${sdk.repo}/tags?per_page=100`, '--jq', '.[].name'], '')
    .trim().split('\n').filter(Boolean);
  prevTag = tags.find((t) => t !== tag) || '';
}
const prevVersion = prevTag.replace(/^v/, '');

/* ---------------- diff ---------------- */
let files = [];
let commits = [];
if (prevTag && !offline) {
  const cmp = gh(['api', `repos/${sdk.repo}/compare/${prevTag}...${tag}`], '{}');
  try {
    const j = JSON.parse(cmp);
    commits = (j.commits || []).map((c) => ({
      sha: c.sha.slice(0, 7), msg: c.commit.message.split('\n')[0],
    }));
    const NOISE = /(^|\/)(dist|vendor|node_modules|coverage)\/|(package-lock|composer\.lock|Gemfile\.lock|go\.sum)$/;
    files = (j.files || []).filter((f) => !NOISE.test(f.filename));
    writeFileSync(join(out, 'compare.diff'), files
      .map((f) => `--- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})\n${f.patch || ''}`)
      .join('\n\n'));
  } catch { /* leave empty */ }
}

/* ---------------- linked PR bodies (where the real prose lives) ---------------- */
const prNums = [...new Set([...(release.body || '').matchAll(/\/pull\/(\d+)/g)].map((m) => m[1]))];
for (const n of prNums.slice(0, 10)) {
  const pr = gh(['pr', 'view', n, '--repo', sdk.repo, '--json', 'title,body'], '');
  if (!pr) continue;
  try {
    const j = JSON.parse(pr);
    writeFileSync(join(out, 'untrusted', `pr-${n}.md`),
      sanitise(`# ${j.title}\n\n${j.body || '(no body)'}`));
  } catch { /* skip */ }
}

/* ---------------- the SDK's own CHANGELOG section ---------------- */
const sdkRoot = arg('sdk-root');
if (sdkRoot && existsSync(join(sdkRoot, 'CHANGELOG.md'))) {
  const cl = readFileSync(join(sdkRoot, 'CHANGELOG.md'), 'utf8');
  const esc = version.replace(/\./g, '\\.');
  const m = cl.match(new RegExp(`^#{1,3}\\s*\\[?${esc}\\]?.*$([\\s\\S]*?)(?=^#{1,3}\\s|$)`, 'm'));
  if (m) writeFileSync(join(out, 'untrusted', 'sdk-changelog.md'), sanitise(m[0]));
}

/* ---------------- signals ---------------- */
const inSurface = (name) =>
  sdk.apiSurface.some((g) => matchGlob(g, name)) &&
  !sdk.apiSurfaceExclude.some((g) => matchGlob(g, name));

const apiSurfaceTouched = files.some((f) => inSurface(f.filename));
const docSignals = files.some((f) =>
  /^(examples|tests|spec)\//.test(f.filename) || /README\.md$/.test(f.filename));

const untrustedBlob = ['release-body.md', 'sdk-changelog.md', ...prNums.map((n) => `pr-${n}.md`)]
  .map((f) => { try { return readFileSync(join(out, 'untrusted', f), 'utf8'); } catch { return ''; } })
  .join('\n');
const breakingText = /BREAKING[ -]CHANGE|^\w+!:|#### Breaking|\bbreaking change\b/im.test(untrustedBlob);

// Identifiers whose lines actually moved in this release.
const touched = new Set();
for (const f of files) {
  if (!inSurface(f.filename)) continue;
  for (const line of (f.patch || '').split('\n')) {
    if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
    // Strip the diff marker: the param patterns are anchored with ^\s* and
    // would never match a line that still begins with '+' or '-'.
    const src = line.slice(1);
    for (const re of [...sdk.symbolPatterns, ...sdk.paramPatterns]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        for (const g of m.slice(1)) if (g && g.length >= 3) touched.add(g);
      }
    }
  }
}

// Which docs pages mention a touched identifier INSIDE this SDK's own fences.
// This is the signal that upgrades changelog-only to surface when the docs
// currently describe behaviour the release changed.
const docsMentions = [];
for (const page of globSync('{guides,quickstart,sdks}/**/*.mdx').sort()) {
  let fences;
  try { fences = parseFences(readFileSync(page, 'utf8')); } catch { continue; }
  const mine = fences.filter((f) => ownerOf(f) === sdkId);
  if (!mine.length) continue;
  const hay = mine.map((f) => f.body).join('\n');
  if ([...touched].some((t) => hay.includes(t))) docsMentions.push(page);
}

const signals = {
  semverBump: semverBump(prevVersion, version),
  apiSurfaceTouched,
  docSignals,
  breakingText,
  touchedIdentifiers: [...touched].sort(),
  docsMentions,
  changedFiles: files.map((f) => f.filename),
  commitCount: commits.length,
  // Deliberately not auto-derived here: telling added from removed from
  // signature-changed reliably needs both worktrees checked out. The workflow
  // supplies these when it has them; absent, the tier falls back to the semver
  // bump plus docsMentions, which errs toward `sweep` by design.
  publicSymbolDelta: { added: [], removed: [], signatureChanged: [] },
  paramDelta: { added: [], removed: [], nowRequired: [], nowOptional: [] },
};

const verdict = classify({ release, version, prevVersion, signals });
const glob = (p) => globSync(p).sort();
const allowlist = verdict.tier === 'abort'
  ? []
  : allowlistFor({ tier: verdict.tier, sdk, mentions: docsMentions, glob });

const context = {
  schema: 1,
  sdk: sdkId,
  sdkName: sdk.changelogHeading,
  repo: sdk.repo,
  version, tag, prevTag, prevVersion,
  tier: verdict.tier,
  tierWhy: verdict.why,
  release: {
    publishedAt: release.publishedAt,
    url: release.url,
    isPrerelease: release.isPrerelease,
  },
  signals,
  allowlist,
  budget: BUDGET,
  sdkRoot: sdkRoot || null,
  summaryPath: join(out, 'summary.json'),
  reportPath: join(out, 'gate-report.json'),
};
writeFileSync(join(out, 'context.json'), JSON.stringify(context, null, 2));

/* ---------------- tasks.md: the work order ---------------- */
const rows = [];
let i = 0;
for (const f of allowlist) {
  i++;
  if (f === 'changelog.mdx') {
    rows.push(`| ${i} | \`summary.json\` (NOT changelog.mdx) | tier=${verdict.tier} | ` +
      `Do NOT edit changelog.mdx. Write \`${join(out, 'summary.json')}\`; a deterministic ` +
      `renderer splices the <Update> block. | schema-validated |`);
    continue;
  }
  const key = Object.keys(BUDGET).find((k) => k !== 'default' && f.startsWith(k));
  const b = BUDGET[key] || BUDGET.default;
  const budget = b.maxChangedPct ? `<=${b.maxChangedPct}% of the file` : `<=${b.maxChangedLines} changed lines`;

  let why;
  let what;
  if (f === `${sdk.mainPage}.mdx`) {
    why = 'SDK main page';
    what = `Update the ${sdk.fenceLangs[0]} samples and the parameter table to match ${tag}.`;
  } else if (docsMentions.includes(f)) {
    why = `contains a ${sdkId} fence referencing a changed identifier`;
    // The allowlist is a PERMISSION, not an obligation. Identifier matching is
    // deliberately fail-safe, so a generic token (`text`, `from`) pulls in more
    // pages than actually need editing. Say so, or the agent edits all of them
    // to look diligent and blows the review budget.
    what = `Inspect the ${sdk.fenceLabels[0]} fence(s). Change them ONLY if ${tag} actually `
         + `invalidates what they show; if they are still correct, leave the file untouched. `
         + `Every sibling fence must stay byte-identical.`;
  } else {
    why = `tier=${verdict.tier} spread`;
    what = `Review the ${sdk.fenceLabels[0]} fence(s) only; edit if ${tag} changed them, otherwise leave the file untouched.`;
  }
  rows.push(`| ${i} | \`${f}\` | ${why} | ${what} | ${budget} |`);
}

writeFileSync(join(out, 'tasks.md'), [
  `# Work order — ${sdk.changelogHeading} ${tag}`,
  '',
  `- tier: **${verdict.tier}** (${verdict.why})`,
  `- previous release: \`${prevTag || '(none)'}\``,
  `- changed SDK files: ${files.length}`,
  `- identifiers touched: ${signals.touchedIdentifiers.join(', ') || '(none detected)'}`,
  '',
  'You may edit these files and no others. This is a permission list, not a',
  'checklist: leaving a listed file untouched because it is still correct is a',
  'good outcome. You do not decide scope, but you do decide necessity.',
  '',
  '| # | File | Why it is in scope | What to change | Budget |',
  '|---|------|--------------------|----------------|--------|',
  ...rows,
  '',
].join('\n'));

console.log(`tier=${verdict.tier} files=${allowlist.length} prev=${prevTag || '(none)'}`);
console.log(`why: ${verdict.why}`);
for (const f of allowlist) console.log(`  - ${f}`);
