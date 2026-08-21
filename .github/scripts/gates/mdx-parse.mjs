/**
 * Gate: every changed .mdx must compile.
 *
 * An unclosed <Update> or <CodeGroup> breaks the whole Mintlify build, and it is
 * exactly the class of error a model actually makes. Frontmatter is stripped
 * before compiling because it is YAML, not MDX.
 */

import { readFileSync } from 'node:fs';
import { splitFrontmatter } from '../lib/mdx.mjs';

export async function run({ files }) {
  const findings = [];
  let compile, remarkGfm;
  try {
    ({ compile } = await import('@mdx-js/mdx'));
    remarkGfm = (await import('remark-gfm')).default;
  } catch {
    return [{ path: '.github/scripts', gate: 'mdx-parse', level: 'advisory',
      message: 'skipped: @mdx-js/mdx not installed (run npm ci in .github/scripts)' }];
  }

  for (const path of files.filter((f) => f.endsWith('.mdx'))) {
    const { body } = splitFrontmatter(readFileSync(path, 'utf8'));
    try {
      await compile(body, { remarkPlugins: [remarkGfm] });
    } catch (e) {
      const where = e.line ? ` at line ${e.line}` : '';
      findings.push({ path, gate: 'mdx-parse', level: 'blocking',
        message: `MDX compile failed${where}: ${e.reason || e.message}` });
    }
  }
  return findings;
}

export default { name: 'mdx-parse', run };
