/**
 * Gate: every API identifier written into a fence must exist in the shipped SDK.
 *
 * Mechanises the prompt's "never invent an API". This is also why prompt
 * injection cannot fabricate one: a fabricated method would have to already
 * exist in the released source to pass.
 *
 * Catches the documented real-world classes:
 *   - Python's Emails.send() takes `sender=`, not `from=` (`from` is a keyword)
 *   - Ruby exposes lowercase emails/webhooks/events
 *   - Node declares `attachmentURLTimeout` but never forwards it
 *
 * False positives (local variables, JSON response keys, loop counters) are
 * suppressed by lib/symbol-stoplist.txt, seeded from a dry run over the current
 * tree so the baseline is green on day one.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parseFences, ownerOf } from '../lib/mdx.mjs';
import { sdkOrDie } from '../lib/sdk-registry.mjs';

const STOPLIST = '.github/scripts/lib/symbol-stoplist.txt';

function stoplist() {
  if (!existsSync(STOPLIST)) return new Set();
  return new Set(
    readFileSync(STOPLIST, 'utf8')
      .split('\n')
      .map((l) => l.replace(/#.*$/, '').trim())
      .filter(Boolean),
  );
}

/** Compile a simple glob (supports `**`, `*`) to a RegExp anchored at both ends. */
function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = esc
    .replace(/\*\*\//g, '\u0000SLASH\u0000')
    .replace(/\*\*/g, '\u0000ANY\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000SLASH\u0000/g, '(?:.*/)?')
    .replace(/\u0000ANY\u0000/g, '.*');
  return new RegExp(`^${body}$`);
}

/**
 * Concatenate the SDK's ground-truth sources into one haystack.
 *
 * The glob list must be matched properly: a naive prefix check makes `*.go`
 * match nothing, which silently empties the haystack and turns the gate into a
 * false-positive machine (it reported Go's real `StartFrom` field as missing).
 */
export function groundTruth(sdkRoot, sdk) {
  const res = sdk.groundTruth.map(globToRe);
  const parts = [];
  let matched = 0;

  const walk = (dir, depth = 0) => {
    if (depth > 8) return;
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (['node_modules', '.git', 'vendor', 'dist', 'coverage', 'env', '.pytest_cache'].includes(e)) continue;
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p, depth + 1); continue; }
      const rel = p.slice(sdkRoot.length + 1);
      if (!res.some((re) => re.test(rel))) continue;
      try { parts.push(readFileSync(p, 'utf8')); matched++; } catch { /* unreadable */ }
    }
  };
  walk(sdkRoot);

  if (!matched) {
    throw new Error(
      `ground truth is empty for ${sdk.repo} at ${sdkRoot} — globs matched no files ` +
      `(${sdk.groundTruth.join(', ')}). Refusing to run the symbol gate against an ` +
      `empty haystack, which would flag every identifier as missing.`);
  }
  return parts.join('\n');
}

/** Identifiers newly introduced into this SDK's fences. */
export function newIdentifiers({ files, sdkId, baseRef = 'HEAD' }) {
  const sdk = sdkOrDie(sdkId);
  const found = new Map();                          // ident -> {path, kind}

  for (const path of files.filter((f) => f.endsWith('.mdx'))) {
    if (!existsSync(path)) continue;

    // Only lines that are actually new in this diff.
    let addedLines = new Set();
    try {
      const diff = execFileSync('git', ['diff', '-U0', baseRef, '--', path], { encoding: 'utf8' });
      for (const l of diff.split('\n')) {
        if (l.startsWith('+') && !l.startsWith('+++')) addedLines.add(l.slice(1));
      }
    } catch { continue; }
    if (!addedLines.size) continue;

    let fences;
    try { fences = parseFences(readFileSync(path, 'utf8')); } catch { continue; }

    for (const f of fences) {
      if (ownerOf(f) !== sdkId) continue;            // only our own fences
      for (const line of f.body.split('\n')) {
        if (!addedLines.has(line)) continue;         // only newly added lines
        for (const re of sdk.symbolPatterns) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(line)) !== null) {
            for (const g of m.slice(1)) if (g) found.set(g, { path, kind: 'symbol' });
          }
        }
        for (const re of sdk.paramPatterns) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(line)) !== null) {
            if (m[1]) found.set(m[1], { path, kind: 'param' });
          }
        }
      }
    }
  }
  return found;
}

export function run({ files, sdk: sdkId, sdkRoot, baseRef = 'HEAD', seed = false }) {
  if (!sdkRoot || !existsSync(sdkRoot)) {
    return [{ path: '.', gate: 'symbol', level: 'advisory',
      message: `skipped: SDK checkout not available at ${sdkRoot}` }];
  }
  const sdk = sdkOrDie(sdkId);
  const hay = groundTruth(sdkRoot, sdk);
  const stop = seed ? new Set() : stoplist();
  const idents = newIdentifiers({ files, sdkId, baseRef });

  const findings = [];
  for (const [ident, meta] of idents) {
    if (stop.has(ident)) continue;
    if (ident.length < 3) continue;                  // i, id, x
    if (hay.includes(ident)) continue;
    findings.push({
      path: meta.path, gate: 'symbol', level: 'blocking', ident,
      message: `${meta.kind} '${ident}' does not appear anywhere in ${sdk.repo} at this release — ` +
               `if it cannot be grepped in the SDK source, it does not exist`,
    });
  }
  return findings;
}

export default { name: 'symbol', run };
