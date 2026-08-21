#!/usr/bin/env node
/**
 * Mutate docs.json navigation. The agent calls this rather than hand-editing
 * 7 KB of JSON.
 *
 *   node .github/scripts/nav-insert.mjs --group Go --after sdks/go/send-with-go --page sdks/go/send-with-gin
 *   node .github/scripts/nav-insert.mjs --new-group Rust --in SDKs --pages sdks/rust/introduction
 *
 * Refuses to run unless docs.json is JSON round-trip stable, so a nav change is
 * a clean one-line diff instead of a whole-file reformat.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'docs.json';
const arg = (n) => {
  const h = process.argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!h) return undefined;
  if (h.includes('=')) return h.slice(h.indexOf('=') + 1);
  const nx = process.argv[process.argv.indexOf(h) + 1];
  return nx && !nx.startsWith('--') ? nx : true;
};

const raw = readFileSync(FILE, 'utf8');
const cfg = JSON.parse(raw);
const canonical = `${JSON.stringify(cfg, null, 2)}\n`;

if (raw !== canonical) {
  console.error(
    `${FILE} is not JSON round-trip stable, so writing it would reformat the whole file.\n` +
    'Normalise it once in a separate commit:\n' +
    `  node -e "const f='${FILE}';const j=require('./'+f);` +
    `require('fs').writeFileSync(f, JSON.stringify(j,null,2)+'\\n')"`);
  process.exit(1);
}

/** Find a group object by label, anywhere in the tree. */
function findGroup(node, label) {
  if (Array.isArray(node)) {
    for (const n of node) { const r = findGroup(n, label); if (r) return r; }
    return null;
  }
  if (node && typeof node === 'object') {
    if (node.group === label) return node;
    for (const k of ['pages', 'groups', 'tabs']) {
      if (Array.isArray(node[k])) { const r = findGroup(node[k], label); if (r) return r; }
    }
    if (node.navigation) return findGroup(node.navigation, label);
  }
  return null;
}

const newGroup = arg('new-group');
if (newGroup) {
  const parent = findGroup(cfg.navigation, arg('in') || 'SDKs');
  if (!parent) { console.error(`no group '${arg('in')}' found`); process.exit(1); }
  const pages = String(arg('pages') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!pages.length) { console.error('--pages is required'); process.exit(1); }
  if (parent.pages.some((p) => p && p.group === newGroup)) {
    console.log(`group '${newGroup}' already present`); process.exit(0);
  }
  parent.pages.push({ group: newGroup, pages });
  writeFileSync(FILE, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`added group '${newGroup}' with ${pages.length} page(s)`);
  process.exit(0);
}

const group = arg('group');
const page = arg('page');
if (!group || !page) {
  console.error('usage: --group <Label> --page <slug> [--after <slug>]');
  process.exit(1);
}
const g = findGroup(cfg.navigation, group);
if (!g) { console.error(`no group '${group}' found in ${FILE}`); process.exit(1); }
if (!Array.isArray(g.pages)) { console.error(`group '${group}' has no pages array`); process.exit(1); }
if (g.pages.includes(page)) { console.log(`'${page}' already in '${group}'`); process.exit(0); }

const after = arg('after');
const at = after ? g.pages.indexOf(after) : -1;
if (after && at === -1) { console.error(`--after '${after}' is not in group '${group}'`); process.exit(1); }
g.pages.splice(at === -1 ? g.pages.length : at + 1, 0, page);

writeFileSync(FILE, `${JSON.stringify(cfg, null, 2)}\n`);
console.log(`inserted '${page}' into '${group}'${after ? ` after '${after}'` : ''}`);
