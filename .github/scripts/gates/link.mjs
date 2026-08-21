/**
 * Gate: internal links in changed files must resolve.
 *
 * Catches the `/sdks/nodejs` vs `/sdks/nodejs/introduction` class of bug -- a
 * directory href that is not a real page. Baseline-diffed, because the repo has
 * 6 such pre-existing occurrences that were deliberately left in place.
 *
 * The repo's own lychee CI only checks CHANGED files, which is how those 6
 * survived. This gate has the same blind spot by design (it scopes to the
 * release's diff) but the baseline makes the debt explicit rather than invisible.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { navPages } from '../lib/nav.mjs';

const BASELINE = '.github/scripts/lib/known-gaps.json';
const LINK = /\]\((\/[^)#?\s]*)(?:[#?][^)\s]*)?\)/g;
const HREF = /(?:href|url)=["'](\/[^"'#?]*)(?:[#?][^"']*)?["']/g;

export function run({ files, today = new Date().toISOString().slice(0, 10) }) {
  const findings = [];
  const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
  const known = new Map((base.link ?? []).map((e) => [e.id, e]));

  let navSet;
  try { navSet = new Set(navPages()); } catch { navSet = new Set(); }

  const resolves = (target) => {
    const slug = target.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!slug) return true;                                  // site root
    if (navSet.has(slug)) return true;
    if (['.mdx', '.md'].some((e) => existsSync(`${slug}${e}`))) return true;
    // An asset FILE resolves (images/hero.png). A DIRECTORY does not: Mintlify
    // has no directory indexes, so `/sdks/nodejs` is a 404 even though the
    // directory exists. Treating a directory as resolvable is precisely how the
    // repo's existing `/sdks/nodejs` links went unnoticed.
    if (existsSync(slug) && statSync(slug).isFile()) return true;
    return false;
  };

  for (const path of files.filter((f) => /\.(mdx|md)$/.test(f))) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    for (const re of [LINK, HREF]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const target = m[1];
        if (resolves(target)) continue;
        const id = `${path}:${target}`;
        const k = known.get(id) ?? known.get(target);
        const message = `internal link '${target}' does not resolve to a page or asset`;
        if (k) {
          const expired = k.expires && k.expires < today;
          findings.push({ path, gate: 'link', level: expired ? 'blocking' : 'advisory',
            message: expired ? `${message} — baseline exemption expired on ${k.expires}`
                             : `${message} — known gap${k.expires ? `, expires ${k.expires}` : ''}` });
        } else {
          findings.push({ path, gate: 'link', level: 'blocking', message });
        }
      }
    }
  }
  return findings;
}

export default { name: 'link', run };
