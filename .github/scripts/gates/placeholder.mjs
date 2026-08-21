/**
 * Gate: no placeholder or filler text in added lines.
 * Cheap insurance against a half-finished edit reaching a public site.
 */

import { execFileSync } from 'node:child_process';

const PATTERNS = [
  /\bTODO\b/, /\bTBD\b/, /\bFIXME\b/, /\bXXX\b/,
  /lorem ipsum/i, /\byour-value-here\b/i, /\bREPLACE_ME\b/,
  /<placeholder>/i, /\bcoming soon\b/i, /\bxxxxx+\b/i,
];

export function run({ files, baseRef = 'HEAD' }) {
  const findings = [];
  for (const path of files) {
    let diff;
    try {
      diff = execFileSync('git', ['diff', '-U0', baseRef, '--', path], { encoding: 'utf8' });
    } catch { continue; }

    let lineNo = 0;
    for (const line of diff.split('\n')) {
      const hunk = /^@@ .* \+(\d+)/.exec(line);
      if (hunk) { lineNo = Number(hunk[1]); continue; }
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      const text = line.slice(1);
      for (const re of PATTERNS) {
        if (re.test(text)) {
          findings.push({ path, gate: 'placeholder', level: 'blocking',
            message: `line ${lineNo}: placeholder text matching ${re} — ${text.trim().slice(0, 80)}` });
        }
      }
      lineNo++;
    }
  }
  return findings;
}

export default { name: 'placeholder', run };
