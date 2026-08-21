/**
 * Gate: prove changelog.mdx was machine-written.
 *
 * Re-renders the <Update> block from summary.json and asserts the working-tree
 * changelog.mdx is byte-equal to HEAD's version with exactly that block spliced
 * in. Nothing else in the repo gets this guarantee: it makes the most
 * history-dense file in the docs a byte-equality assertion instead of a hope
 * that the model indented correctly.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export function run({ context, summary, baseRef = 'HEAD' }) {
  if (!context || !summary || !existsSync(context) || !existsSync(summary)) {
    return [{ path: 'changelog.mdx', gate: 'changelog-render', level: 'advisory',
      message: 'skipped: context.json or summary.json not available' }];
  }

  let before;
  try {
    before = execFileSync('git', ['show', `${baseRef}:changelog.mdx`], { encoding: 'utf8' });
  } catch {
    return [{ path: 'changelog.mdx', gate: 'changelog-render', level: 'blocking',
      message: `cannot read changelog.mdx at ${baseRef}` }];
  }

  const actual = readFileSync('changelog.mdx', 'utf8');
  if (actual === before) return [];                    // untouched: nothing to prove

  let block;
  try {
    block = execFileSync('node', [
      '.github/scripts/changelog-entry.mjs', '--render-only',
      '--context', context, '--summary', summary,
    ], { encoding: 'utf8' });
  } catch (e) {
    return [{ path: 'changelog.mdx', gate: 'changelog-render', level: 'blocking',
      message: `renderer refused this summary.json: ${(e.stderr?.toString() || e.message).trim().slice(0, 200)}` }];
  }

  const at = before.indexOf('<Update');
  if (at === -1) {
    return [{ path: 'changelog.mdx', gate: 'changelog-render', level: 'blocking',
      message: 'no <Update> block found at base revision' }];
  }
  const expected = before.slice(0, at) + block + '\n\n' + before.slice(at);

  if (actual === expected) return [];

  return [{
    path: 'changelog.mdx', gate: 'changelog-render', level: 'blocking',
    message: 'changelog.mdx does not byte-match the deterministic render of summary.json — ' +
             'it must be written only by changelog-entry.mjs, never edited directly ' +
             `(expected ${expected.length} bytes, found ${actual.length})`,
  }];
}

export default { name: 'changelog-render', run };
