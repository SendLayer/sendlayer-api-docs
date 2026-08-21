/** Shared docs.json navigation reading. */
import { readFileSync } from 'node:fs';

/** Every page slug referenced anywhere in docs.json navigation, recursively. */
export function navPages(docsJsonPath = 'docs.json') {
  const cfg = JSON.parse(readFileSync(docsJsonPath, 'utf8'));
  const pages = [];
  const walk = (node) => {
    if (typeof node === 'string') { pages.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') {
      if (Array.isArray(node.pages)) node.pages.forEach(walk);
      if (Array.isArray(node.groups)) node.groups.forEach(walk);
      if (Array.isArray(node.tabs)) node.tabs.forEach(walk);
      if (node.navigation) walk(node.navigation);
    }
  };
  walk(cfg.navigation ?? cfg);
  return pages;
}

export function readDocsJson(p = 'docs.json') {
  return JSON.parse(readFileSync(p, 'utf8'));
}
