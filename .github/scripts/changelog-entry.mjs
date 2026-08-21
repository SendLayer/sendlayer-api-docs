#!/usr/bin/env node
/**
 * Renders exactly one <Update> block from summary.json + context.json and
 * splices it at the top of changelog.mdx.
 *
 * This is the ONLY code path permitted to write changelog.mdx. The agent emits
 * summary.json as data and never edits the file, which turns the repo's most
 * history-dense file into a byte-equality assertion.
 *
 *   node .github/scripts/changelog-entry.mjs \
 *     --context $RELEASE/context.json --summary $RELEASE/summary.json
 *
 *   --render-only   print the block to stdout, touch nothing
 *   --file <path>   operate on a different changelog (tests)
 *
 * Byte-level invariants, all verified against the live file:
 *   - frontmatter is `---\ntitle\ndescription\nrss: true\n---\n\n`
 *   - the first `<Update` sits at byte offset 91
 *   - body lines are indented exactly 2 spaces
 *   - blank lines inside a block are truly empty, not 2 spaces
 *   - the file has NO trailing newline
 * The last one is why this splices a raw string at a byte offset instead of
 * round-tripping through split('\n')/join('\n'): a naive rewrite appends a byte
 * and produces a spurious final-line hunk on every run.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { sdkOrDie } from './lib/sdk-registry.mjs';

const INDENT = '  ';
const SERVICES = ['Email', 'Events', 'Webhooks'];

function arg(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  const i = process.argv.indexOf(hit);
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const die = (msg) => { console.error(`changelog-entry: ${msg}`); process.exit(1); };

const CHANGELOG = arg('file') || 'changelog.mdx';
const ctx = JSON.parse(readFileSync(arg('context'), 'utf8'));
const sum = JSON.parse(readFileSync(arg('summary'), 'utf8'));
const sdk = sdkOrDie(ctx.sdk);

if (ctx.tier === 'abort') die('context tier is "abort"; refusing to write');

/* ---------------- validate the agent hand-off ---------------- */

const blob = JSON.stringify(sum);
const need = (cond, msg) => { if (!cond) die(`summary.json: ${msg}`); };

need(typeof sum.summaryLine === 'string', 'summaryLine must be a string');
need(sum.summaryLine.trim().length > 15, 'summaryLine must be a real sentence');
need(/[.!]$/.test(sum.summaryLine.trim()), 'summaryLine must end in a period');
need(!/\b(TODO|TBD|FIXME|XXX|lorem ipsum|placeholder)\b/i.test(blob), 'contains a placeholder token');
// Vale error-level and DeveloperVoice terms, rejected before they reach the file.
need(!/\b(we|we'll|we've|we're|our|us|simply|easily|seamless|powerful|quickly)\b/i.test(blob),
     'contains a Vale-flagged word');
need(!/\bas well as\b|\band\/or\b/i.test(blob), 'contains a DisAllow phrase');
if (ctx.tier === 'sweep') {
  need(Array.isArray(sum.summaryBullets) && sum.summaryBullets.length >= 1,
       'a sweep release needs summaryBullets');
}

/* ---------------- label: human date, pinned to UTC ----------------
 * The clock is the GitHub Release's published_at (always UTC ISO-8601).
 * Formatting in the runner's local zone would let the same release produce two
 * different labels depending on when it was picked up, and would shift the
 * calendar day for a late-UTC release. en-US long month, no zero padding, to
 * match every existing entry ("October 9, 2025").                         */
const publishedAt = ctx.release?.publishedAt;
if (!publishedAt) die('context.release.publishedAt is required');
const label = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric',
}).format(new Date(publishedAt));

/* ---------------- description ---------------- */
const version = String(ctx.version).replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`not a stable release version: ${version}`);
const description = `v${version}`;

/* ---------------- body ---------------- */

// Blank lines stay truly empty; every other line gets exactly 2 spaces.
const indent = (block) => block
  .split('\n')
  .map((l) => (l.trim() === '' ? '' : INDENT + l))
  .join('\n');

const fence = (code) => ['```' + sdk.fenceLangs[0], code.replace(/\n+$/, ''), '```'];

function patchBody() {
  return [`### ${sdk.changelogHeading}`, '', sum.summaryLine.trim()].join('\n');
}

function sweepBody() {
  const out = [`### ${sdk.changelogHeading}`, '', sum.summaryLine.trim()];

  out.push('', '#### Summary', '');
  for (const b of sum.summaryBullets) out.push(`- ${b}`);

  // Sections with no real content are omitted; an empty heading is worse
  // than an absent one.
  let detailsOpen = false;
  for (const svc of SERVICES) {
    const lines = sum.details?.[svc] ?? [];
    if (!lines.length) continue;
    if (!detailsOpen) { out.push('', '#### Details'); detailsOpen = true; }
    out.push('', `**${svc}**`);
    for (const l of lines) out.push(`- ${l}`);
  }

  if (sum.breaking?.length) {
    out.push('', '#### Breaking Changes', '');
    for (const l of sum.breaking) out.push(`- ${l}`);
  }

  if (sum.migration?.before && sum.migration?.after) {
    // No blank line between the **Before**/**After** label and its fence --
    // matches the live Go v1.0.0 entry exactly.
    out.push('', '#### Migration Example', '',
             '**Before**', ...fence(sum.migration.before),
             '', '**After**', ...fence(sum.migration.after));
  }

  return out.join('\n');
}

const body = ctx.tier === 'sweep' ? sweepBody() : patchBody();
const block = `<Update label="${label}" description="${description}">\n${indent(body)}\n</Update>`;

if (arg('render-only')) { process.stdout.write(block); process.exit(0); }

/* ---------------- splice, byte-preserving ---------------- */

const raw = readFileSync(CHANGELOG, 'utf8');
if (!raw.startsWith('---\n')) die(`${CHANGELOG} does not open with frontmatter`);
const fmEnd = raw.indexOf('\n---\n', 3);
if (fmEnd === -1) die('unterminated frontmatter');

// Insert in front of the first existing <Update>, which is always after the
// frontmatter. The frontmatter is never parsed or re-serialised, so `rss: true`
// survives by construction.
const insertAt = raw.indexOf('<Update', fmEnd);
if (insertAt === -1) die('no existing <Update> block to insert in front of');

// Idempotency: match any alias so a legacy heading ("Golang SDK") still counts
// as documented and we do not emit a duplicate entry.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const alias of sdk.changelogAliases) {
  const dup = new RegExp(
    `<Update[^>]*description="${esc(description)}"[^>]*>\\s*###\\s+${esc(alias)}\\b`);
  if (dup.test(raw)) {
    console.log(`already-present: ${alias} ${description} — no change`);
    process.exit(0);
  }
}

writeFileSync(CHANGELOG, raw.slice(0, insertAt) + block + '\n\n' + raw.slice(insertAt));
console.log(`inserted <Update label="${label}" description="${description}"> ${sdk.changelogHeading}`);
