/**
 * Gate: code fences must parse.
 *
 * Ported from sendlayer-skills/scripts/check-snippets.mjs. Four changes from the
 * original:
 *   1. Input is the release's changed .mdx files, not skills/**\/*.md.
 *   2. Uses the shared parseFences() so labelled fences (```go send_email.go)
 *      are seen -- the original regex only matched ```lang with no label.
 *   3. Only fences OWNED by the releasing SDK are checked, so a pre-existing
 *      unparseable Python fence cannot fail a Go release.
 *   4. A missing interpreter is reported as advisory, never as a pass.
 *
 * The three skip heuristics are kept verbatim: they encode real decisions about
 * documentation fragments, and this repo has the same fragment classes (its
 * house convention IS the path-headed comment style).
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFences, ownerOf } from '../lib/mdx.mjs';

/** A fragment introduced by a `// path/to/file.ext` or `# path/to/file.ext` comment. */
const isPathHeadedFragment = (code) =>
  /^\s*(\/\/|#)\s*\S+\.(php|py|rb|js|ts|json|ya?ml)\b/.test(code);

/** A correct-vs-wrong illustration: a line labelled with the error it raises. */
const isErrorIllustration = (code) =>
  /(SyntaxError|NoMethodError|TypeError|ImportError|wrong|WRONG|fails|Unknown named parameter)/.test(code) &&
  /(\.\.\.|#|\/\/)/.test(code);

/** A bare object/hash-literal fragment showing field shapes. */
const isLiteralFragment = (code) => /^\s*['"]?[\w$-]+['"]?\s*(:|=>)/.test(code.trim());

/**
 * Strip string literals, template literals and comments. HTML inside a string
 * (`html: '<p>a <strong>b</strong></p>'`) must not read as JSX -- that false
 * positive masked two genuinely broken samples on first run.
 */
const stripLiterals = (code) => code
  .replace(/\\./g, '')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  .replace(/\/\/[^\n]*/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * JSX/TSX in a ```javascript fence. `node --check` cannot parse JSX, and the
 * Next.js / Nuxt framework pages legitimately show component markup. Tested
 * against literal-stripped code so a genuine syntax error in a plain JS fence
 * is still caught. (Not needed in the sendlayer-skills original -- that repo has
 * no framework pages.)
 */
const isJsx = (code) => {
  const c = stripLiterals(code);
  return /\breturn\s*\(\s*</.test(c)
      || /\bclassName\s*=/.test(c)
      || /<\/[A-Za-z][\w.]*>\s*\)?\s*;?\s*$/m.test(c)
      || /<>\s*$/m.test(c)
      || /\bexport\s+default\s+function\s+\w*\s*\([^)]*\)\s*\{[\s\S]*<[A-Za-z]/.test(c);
};

const LANGS = {
  js: { ext: 'mjs', cmd: (f) => ['node', ['--check', f]] },
  javascript: { ext: 'mjs', cmd: (f) => ['node', ['--check', f]] },
  python: { ext: 'py', cmd: (f) => ['python3', ['-c', `import ast;ast.parse(open(${JSON.stringify(f)}).read())`]] },
  ruby: { ext: 'rb', cmd: (f) => ['ruby', ['-c', f]] },
  php: {
    ext: 'php', cmd: (f) => ['php', ['-l', f]],
    wrap: (c) => (c.trimStart().startsWith('<?php') ? c : `<?php\n${c}`),
  },
  go: { ext: 'go', cmd: (f) => ['gofmt', ['-e', f]], only: (c) => c.includes('package ') },
};

const have = (bin) => {
  try { execFileSync('command', ['-v', bin], { stdio: 'ignore', shell: true }); return true; }
  catch { return false; }
};

export function run({ files, sdk: sdkId }) {
  const findings = [];
  const dir = mkdtempSync(join(tmpdir(), 'sl-snip-'));
  const skippedTools = new Set();
  let checked = 0;

  for (const path of files.filter((f) => f.endsWith('.mdx'))) {
    if (!existsSync(path)) continue;
    let fences;
    try { fences = parseFences(readFileSync(path, 'utf8')); }
    catch (e) {
      findings.push({ path, gate: 'snippets', level: 'blocking', message: e.message });
      continue;
    }

    for (const f of fences) {
      // Only the releasing SDK's own fences.
      if (sdkId && ownerOf(f) !== sdkId) continue;
      const spec = LANGS[f.lang];
      if (!spec) continue;

      const code = f.body;
      if (isPathHeadedFragment(code) || isErrorIllustration(code) || isLiteralFragment(code)) continue;
      if (/^(js|javascript)$/.test(f.lang) && isJsx(code)) continue;   // JSX: node --check cannot parse it
      if (spec.only && !spec.only(code)) continue;

      const bin = spec.cmd('x')[0];
      if (!have(bin)) { skippedTools.add(bin); continue; }

      const tmp = join(dir, `s${checked}.${spec.ext}`);
      writeFileSync(tmp, spec.wrap ? spec.wrap(code) : code);
      const [cmd, args] = spec.cmd(tmp);
      try {
        execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        checked++;
      } catch (e) {
        // node --check prints the file path first; the useful line is the
        // SyntaxError plus the offending source line.
        const raw = (e.stderr?.toString() || e.message);
        const err = (raw.match(/^\w*(?:Syntax)?Error.*$/m)?.[0]
                  ?? raw.split('\n').find((l) => /error/i.test(l))
                  ?? raw.split('\n')[0] ?? '').trim().slice(0, 160);
        findings.push({
          path, gate: 'snippets', level: 'blocking',
          message: `${f.lang} fence at line ${f.start + 1} does not parse: ${err}`,
        });
      }
    }
  }

  for (const bin of skippedTools) {
    findings.push({ path: '.', gate: 'snippets', level: 'advisory',
      message: `skipped some fences: '${bin}' is not installed on this runner` });
  }
  return findings;
}

export default { name: 'snippets', run };
