#!/usr/bin/env node
/**
 * Append a term to the Vale vocabulary.
 *
 * Two things make this less trivial than it looks:
 *
 * 1. Entries are REGEXES, not literals. The file already holds `[Gg]in`,
 *    `[Gg]olang`, `[Rr]ails`, `Next\.js`. A literal `has()` check therefore
 *    reports false negatives and appends duplicates.
 * 2. The file is UNSORTED and must stay that way. Re-sorting it produces a
 *    40-line churn diff on a one-term change, which is unreviewable.
 *
 * So: strictly append-only, presence tested by evaluating each existing entry
 * as an anchored regex.
 *
 * Vale.Terms is generated from this list and is ERROR level, so adding
 * `Symfony` makes `symfony` an error everywhere in the docs.
 *
 *   node .github/scripts/vocab-add.mjs Symfony
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = '.github/styles/config/vocabularies/SendLayer/accept.txt';
const terms = process.argv.slice(2).filter(Boolean);

if (!terms.length) {
  console.error('usage: vocab-add.mjs <Term> [Term...]');
  process.exit(1);
}
for (const t of terms) {
  if (!/^[A-Za-z][A-Za-z0-9.'’-]*$/.test(t)) {
    console.error(`refusing '${t}': a vocabulary entry must be a single word-like token`);
    process.exit(1);
  }
}

const raw = readFileSync(FILE, 'utf8');
const entries = raw.split('\n').map((l) => l.trim()).filter(Boolean);

const covers = (entry, term) => {
  try { return new RegExp(`^(?:${entry})$`).test(term); }
  catch { return entry === term; }        // not a valid regex: compare literally
};

const added = [];
for (const t of terms) {
  if (entries.some((e) => covers(e, t))) {
    console.log(`already covered by an existing entry: ${t}`);
    continue;
  }
  entries.push(t);
  added.push(t);
}

if (!added.length) process.exit(0);

// Append-only: preserve the existing order exactly, add at the end, keep the
// file's single trailing newline.
writeFileSync(FILE, `${entries.join('\n')}\n`);
console.log(`appended: ${added.join(', ')} (${entries.length} entries total)`);
