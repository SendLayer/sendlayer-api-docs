/**
 * Gate: Vale prose lint, error level blocks, everything else advises.
 *
 * The split is measured, not guessed. Only four checks are error-level in this
 * repo's own config (Vale.Spelling, Vale.Terms, SendLayer.DisAllow); the rest --
 * HeadingTitleCase, BrandWords, DeveloperVoice, FirstPerson, SentenceLength,
 * Readability -- are warning or suggestion. The repo's own CI runs Vale with
 * `fail_on_error: false`, so a local gate stricter than the repo's own policy
 * would stall the pipeline on subjective style, and a stalling pipeline gets
 * switched off. The Vale PR bot still comments inline; a human is a better
 * arbiter of title case than a blocking gate.
 *
 * Vale needs mdx2vast to parse .mdx. Without it Vale silently under-reports, so
 * a missing mdx2vast is reported as advisory rather than treated as a pass.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const have = (bin) => {
  try { execFileSync('command', ['-v', bin], { stdio: 'ignore', shell: true }); return true; }
  catch { return false; }
};

export function run({ files, addedOnly = true, baseRef = 'HEAD' }) {
  const targets = files.filter((f) => /\.mdx?$/.test(f) && existsSync(f)
    && /^(guides|quickstart|sdks)\//.test(f));
  if (!targets.length) return [];

  if (!have('vale')) {
    return [{ path: '.', gate: 'vale', level: 'advisory',
      message: 'skipped: vale is not installed on this runner' }];
  }
  const findings = [];
  if (!have('mdx2vast')) {
    findings.push({ path: '.', gate: 'vale', level: 'advisory',
      message: 'mdx2vast is not installed, so Vale under-reports on .mdx — run `npm i -g mdx2vast`' });
  }

  // Only lines this release added, matching the repo CI's filter_mode: added.
  const addedByFile = new Map();
  if (addedOnly) {
    for (const f of targets) {
      const set = new Set();
      try {
        const diff = execFileSync('git', ['diff', '-U0', baseRef, '--', f], { encoding: 'utf8' });
        let n = 0;
        for (const l of diff.split('\n')) {
          const h = /^@@ .* \+(\d+)/.exec(l);
          if (h) { n = Number(h[1]); continue; }
          if (l.startsWith('+') && !l.startsWith('+++')) { set.add(n); n++; }
        }
      } catch { /* no diff */ }
      addedByFile.set(f, set);
    }
  }

  let out = '';
  try {
    out = execFileSync('vale', ['--output=JSON', '--no-exit', ...targets], { encoding: 'utf8' });
  } catch (e) {
    out = e.stdout?.toString() || '';
    if (!out) {
      return [...findings, { path: '.', gate: 'vale', level: 'advisory',
        message: `vale did not produce JSON output: ${(e.stderr?.toString() || e.message).slice(0, 140)}` }];
    }
  }

  let parsed;
  try { parsed = JSON.parse(out); } catch {
    return [...findings, { path: '.', gate: 'vale', level: 'advisory',
      message: 'could not parse vale JSON output' }];
  }

  for (const [path, alerts] of Object.entries(parsed)) {
    const rel = path.replace(`${process.cwd()}/`, '');
    const added = addedByFile.get(rel);
    for (const a of alerts) {
      if (addedOnly && added && added.size && !added.has(a.Line)) continue;
      findings.push({
        path: rel, gate: 'vale',
        level: a.Severity === 'error' ? 'blocking' : 'advisory',
        message: `line ${a.Line} [${a.Check}] ${a.Message}`,
      });
    }
  }
  return findings;
}

export default { name: 'vale', run };
