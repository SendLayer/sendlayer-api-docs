/**
 * Gate: sibling CodeGroup fences must come out byte-identical.
 *
 * Every polyglot <CodeGroup> in this repo holds fences in a fixed order
 * (JavaScript, Python, PHP, Ruby, Go, cURL). A single-language release may edit
 * only its own fence; the siblings must not move by even one space. This is the
 * hardest invariant in the repo to hold by hand and is fully machine-checkable.
 *
 * Identity is (codegroup#, section, lang, label, duplicate-index), never a
 * positional ordinal -- verified unique across all 300 fences in the repo, so
 * the guard survives INSERTION of a new fence.
 *
 * On the duplicate-index: inserting a fence shifts the dup index only among
 * fences sharing the same (group, section, lang, label). Ownership is decided by
 * lang/label, so a shift can only ever affect fences owned by the releasing SDK
 * -- which that SDK is already permitted to change. A non-owner's fences can
 * therefore never be perturbed by an insertion. Verified by inserting a `go Go`
 * fence mid-CodeGroup: sdk=go reported 0 findings while the javascript, php and
 * ruby siblings were untouched.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseFences, ownerOf, fenceKeys } from '../lib/mdx.mjs';

function atRef(path, ref) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;                                   // new file: nothing to preserve
  }
}

export function checkFile(path, sdkId, baseRef = 'HEAD') {
  const before = atRef(path, baseRef);
  if (before === null) return [];

  let a, b;
  try {
    a = fenceKeys(parseFences(before));
    b = fenceKeys(parseFences(readFileSync(path, 'utf8')));
  } catch (e) {
    return [{ path, gate: 'fence', level: 'blocking', message: e.message }];
  }

  const errs = [];
  const err = (message) => errs.push({ path, gate: 'fence', level: 'blocking', message });

  for (const [key, f] of a) {
    const owner = ownerOf(f);
    if (owner === sdkId) continue;                 // ours: free to change

    const nf = b.get(key);
    const who = owner ?? 'no SDK (shared/REST fence)';
    if (!nf) {
      err(`fence [${key}] belonging to ${who} was removed or its info string changed`);
      continue;
    }
    if (nf.body !== f.body) {
      err(`fence [${key}] was modified but belongs to ${who}, not ${sdkId}`);
    }
    if (nf.indent !== f.indent) {
      err(`fence [${key}] indentation changed (${JSON.stringify(f.indent)} -> ${JSON.stringify(nf.indent)})`);
    }
  }

  for (const [key, f] of b) {
    if (a.has(key)) continue;
    const owner = ownerOf(f);
    if (owner !== sdkId) {
      err(`new fence [${key}] does not belong to ${sdkId} (resolved owner: ${owner ?? 'shared'})`);
    }
  }

  return errs;
}

export function run({ files, sdk, baseRef = 'HEAD' }) {
  return files
    .filter((f) => f.endsWith('.mdx'))
    .flatMap((f) => checkFile(f, sdk, baseRef));
}

export default { name: 'fence', run };
