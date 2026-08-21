/**
 * Gate: nothing outside the agreed doc surfaces may change, and no file may
 * exceed its diff budget.
 *
 * Runs first and cheapest. This is the enforcement arm of the agent's tool
 * policy: `Write` cannot be glob-restricted at the tool level, so the scope
 * guard is what actually constrains it -- post-hoc, before any PR exists.
 */

import { execFileSync } from 'node:child_process';
import { IN_SCOPE, DENIED, BUDGET } from '../lib/sdk-registry.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

export function changedFiles(baseRef = 'HEAD') {
  const out = new Set();
  for (const line of git('status', '--porcelain').split('\n')) {
    if (!line.trim()) continue;
    // Handle renames: "R  old -> new"
    const path = line.slice(3).split(' -> ').pop().replace(/^"|"$/g, '');
    out.add(path);
  }
  for (const line of git('diff', '--name-only', baseRef).split('\n')) {
    if (line.trim()) out.add(line.trim());
  }
  return [...out];
}

function budgetFor(path) {
  if (BUDGET[path]) return { key: path, ...BUDGET[path] };
  for (const [prefix, b] of Object.entries(BUDGET)) {
    if (prefix !== 'default' && path.startsWith(prefix)) return { key: prefix, ...b };
  }
  return { key: 'default', ...BUDGET.default };
}

function numstat(path, baseRef) {
  try {
    const out = git('diff', '--numstat', baseRef, '--', path).trim();
    if (!out) return { added: 0, deleted: 0 };
    const [a, d] = out.split('\n')[0].split('\t');
    return { added: Number(a) || 0, deleted: Number(d) || 0 };
  } catch {
    return { added: 0, deleted: 0 };
  }
}

function fileLines(path, baseRef) {
  try {
    return git('show', `${baseRef}:${path}`).split('\n').length;
  } catch {
    return 0;
  }
}

/**
 * @param ignore  Path prefixes to exclude from consideration entirely. Used only
 *                for local development of the pipeline itself, where the
 *                pipeline's own uncommitted scripts would otherwise register as
 *                scope violations. In CI these files are committed, so the
 *                default empty list is correct and must stay that way.
 */
export function run({ allowlist, baseRef = 'HEAD', extraAllowed = [], ignore = [] }) {
  const findings = [];
  const block = (path, message) =>
    findings.push({ path, gate: 'scope', level: 'blocking', message });

  const allowed = new Set([...(allowlist ?? []), ...extraAllowed]);

  for (const path of changedFiles(baseRef)) {
    if (ignore.some((i) => path === i || path.startsWith(i))) continue;
    // 1. Hard denylist, checked before anything else.
    const denied = DENIED.find((d) => path === d || path.startsWith(d));
    if (denied) {
      block(path, `writes to '${denied}' are never permitted`);
      continue;
    }

    // 2. Must sit under an in-scope surface.
    if (!IN_SCOPE.some((p) => path === p || path.startsWith(p))) {
      block(path, `outside the in-scope doc surfaces (${IN_SCOPE.join(', ')})`);
      continue;
    }

    // 3. Must be on this release's task list.
    if (allowed.size && !allowed.has(path)) {
      block(path, 'not on this release\'s task list; scope is machine-decided, not model-decided');
      continue;
    }

    // 4. Diff budget.
    const b = budgetFor(path);
    const { added, deleted } = numstat(path, baseRef);

    if (b.maxDeleted !== undefined && deleted > b.maxDeleted) {
      block(path, `${deleted} deleted line(s) exceeds maxDeleted=${b.maxDeleted} for '${b.key}'` +
                  (path === 'changelog.mdx'
                    ? ' — changelog.mdx is append-at-top-only; a deletion means release history was clobbered'
                    : ''));
    }
    if (b.maxAdded !== undefined && added > b.maxAdded) {
      block(path, `${added} added line(s) exceeds maxAdded=${b.maxAdded} for '${b.key}'`);
    }
    if (b.maxChangedLines !== undefined && added + deleted > b.maxChangedLines) {
      block(path, `${added + deleted} changed line(s) exceeds maxChangedLines=${b.maxChangedLines} for '${b.key}'`);
    }
    if (b.maxChangedPct !== undefined) {
      const total = fileLines(path, baseRef) || 1;
      const pct = Math.round(((added + deleted) / total) * 100);
      if (pct > b.maxChangedPct) {
        block(path, `${pct}% of the file changed, exceeds maxChangedPct=${b.maxChangedPct} for '${b.key}'`);
      }
    }
  }

  return findings;
}

export default { name: 'scope', run };
