/**
 * Gate: docs.json navigation and the files on disk must agree.
 *
 * Baseline-diffed: only NEW violations block. The repo has pre-existing ones
 * (docs.json lists sdks/go/send-with-gin, which was never written), and a gate
 * that fails on run one gets switched off rather than fixed. Baseline entries
 * carry an `expires` date so they cannot rot silently.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { navPages } from '../lib/nav.mjs';

const BASELINE = '.github/scripts/lib/known-gaps.json';

function baseline() {
  if (!existsSync(BASELINE)) return { nav: [], link: [] };
  return JSON.parse(readFileSync(BASELINE, 'utf8'));
}

export function run({ today = new Date().toISOString().slice(0, 10) } = {}) {
  const findings = [];
  const base = baseline();
  const known = new Map((base.nav ?? []).map((e) => [e.id, e]));

  let pages;
  try {
    pages = navPages();
  } catch (e) {
    return [{ path: 'docs.json', gate: 'nav', level: 'blocking',
      message: `docs.json does not parse: ${e.message}` }];
  }

  const report = (id, path, message) => {
    const k = known.get(id);
    if (k) {
      if (k.expires && k.expires < today) {
        findings.push({ path, gate: 'nav', level: 'blocking',
          message: `${message} — baseline exemption expired on ${k.expires}` });
      } else {
        findings.push({ path, gate: 'nav', level: 'advisory',
          message: `${message} — known gap${k.expires ? `, expires ${k.expires}` : ''}` });
      }
      return;
    }
    findings.push({ path, gate: 'nav', level: 'blocking', message });
  };

  // 1. Every nav page must resolve to a file.
  for (const slug of pages) {
    const hit = ['.mdx', '.md'].map((e) => `${slug}${e}`).find(existsSync);
    if (!hit) report(`missing:${slug}`, 'docs.json', `nav references '${slug}' but no such page exists`);
  }

  // 2. Every page on disk must be in nav (snippets/ is component boilerplate).
  const onDisk = execFileSync('git', ['ls-files', '*.mdx'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  const navSet = new Set(pages);
  for (const f of onDisk) {
    if (f.startsWith('snippets/')) continue;
    const slug = f.replace(/\.mdx$/, '');
    if (!navSet.has(slug)) report(`orphan:${slug}`, f, `page '${slug}' is not referenced in docs.json navigation`);
  }

  // 3. No nav page may silently disappear.
  try {
    const beforeCfg = execFileSync('git', ['show', 'HEAD:docs.json'], { encoding: 'utf8' });
    const tmp = JSON.parse(beforeCfg);
    const collect = (node, acc = []) => {
      if (typeof node === 'string') acc.push(node);
      else if (Array.isArray(node)) node.forEach((n) => collect(n, acc));
      else if (node && typeof node === 'object') {
        for (const key of ['pages', 'groups', 'tabs']) if (Array.isArray(node[key])) node[key].forEach((n) => collect(n, acc));
        if (node.navigation) collect(node.navigation, acc);
      }
      return acc;
    };
    const before = new Set(collect(tmp.navigation ?? tmp));
    for (const slug of before) {
      if (!navSet.has(slug)) {
        findings.push({ path: 'docs.json', gate: 'nav', level: 'blocking',
          message: `nav entry '${slug}' was removed; page removal must be an explicit task` });
      }
    }
  } catch { /* no HEAD:docs.json — new repo or first commit */ }

  return findings;
}

export default { name: 'nav', run };
