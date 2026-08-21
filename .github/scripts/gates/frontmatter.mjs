/**
 * Gate: YAML frontmatter of an existing page must come out byte-identical.
 *
 * Mechanises the prompt's "preserve frontmatter exactly". A reordered or
 * requoted `keywords` array is a pointless review burden, and a dropped
 * `sidebarTitle` silently changes the site navigation.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { splitFrontmatter } from '../lib/mdx.mjs';

function atRef(path, ref) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

export function run({ files, baseRef = 'HEAD' }) {
  const findings = [];

  for (const path of files.filter((f) => f.endsWith('.mdx'))) {
    const before = atRef(path, baseRef);
    const now = readFileSync(path, 'utf8');
    const after = splitFrontmatter(now);

    if (before === null) {
      // New page: must at least declare title and description.
      if (!after.frontmatter) {
        findings.push({ path, gate: 'frontmatter', level: 'blocking',
          message: 'new page has no frontmatter block' });
        continue;
      }
      for (const req of ['title', 'description']) {
        if (!new RegExp(`^${req}:`, 'm').test(after.frontmatter)) {
          findings.push({ path, gate: 'frontmatter', level: 'blocking',
            message: `new page frontmatter is missing '${req}:'` });
        }
      }
      continue;
    }

    const b = splitFrontmatter(before);
    if (b.frontmatter === null) continue;          // nothing to preserve

    if (b.frontmatter !== after.frontmatter) {
      findings.push({ path, gate: 'frontmatter', level: 'blocking',
        message: 'frontmatter was modified; it must be preserved byte-for-byte' });
    }
  }

  return findings;
}

export default { name: 'frontmatter', run };
