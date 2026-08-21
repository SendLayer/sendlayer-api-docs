/**
 * Shared MDX structure parsing: frontmatter split, fenced-code census, and
 * CodeGroup fence ownership. Used by gates/fence.mjs, gates/snippets.mjs,
 * gates/frontmatter.mjs and release-context.mjs so there is exactly one
 * fence parser in the pipeline.
 */

import { SDKS, SHARED_FENCES } from './sdk-registry.mjs';

const FENCE = /^([ \t]*)(`{3,}|~{3,})([A-Za-z0-9+#_.-]*)[ \t]*(.*?)[ \t]*$/;

/**
 * Split frontmatter from body without parsing or re-serialising it. The
 * frontmatter bytes must survive a pipeline run untouched, so we only ever
 * slice, never round-trip through a YAML library.
 */
export function splitFrontmatter(raw) {
  if (!raw.startsWith('---\n')) return { frontmatter: null, body: raw, bodyOffset: 0 };
  const end = raw.indexOf('\n---\n', 3);
  if (end === -1) return { frontmatter: null, body: raw, bodyOffset: 0 };
  const cut = end + 5;
  return { frontmatter: raw.slice(0, cut), body: raw.slice(cut), bodyOffset: cut };
}

/**
 * Every fenced block in the document, with the CodeGroup index and the nearest
 * enclosing `## ` heading. Both are needed to resolve ownership: labels
 * disambiguate polyglot CodeGroups, and the heading disambiguates the
 * unlabelled ```bash install blocks in quickstart/installation.mdx.
 *
 * Handles indented fences and >3 backticks. A closing fence must use the same
 * marker character and be at least as long as the opener, per CommonMark.
 */
export function parseFences(text) {
  const lines = text.split('\n');
  const out = [];
  let open = null;
  let group = 0;
  let inGroup = false;
  let h2 = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!open) {
      const h = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
      if (h) h2 = h[1];
      if (/^[ \t]*<CodeGroup>/.test(line)) { inGroup = true; group++; continue; }
      if (/^[ \t]*<\/CodeGroup>/.test(line)) { inGroup = false; continue; }
    }

    const m = FENCE.exec(line);
    if (!m) continue;
    const [, indent, marker, lang, label] = m;

    if (!open) {
      if (!lang && !label) continue;              // a bare fence can only close
      open = {
        start: i, indent, marker, lang: lang.toLowerCase(), label,
        h2, group: inGroup ? group : 0,
      };
    } else if (
      marker[0] === open.marker[0] &&
      marker.length >= open.marker.length &&
      !lang && !label
    ) {
      out.push({ ...open, end: i, body: lines.slice(open.start + 1, i).join('\n') });
      open = null;
    }
  }

  if (open) {
    throw new Error(`unterminated code fence opened at line ${open.start + 1}`);
  }
  return out;
}

/**
 * Which SDK owns this fence, or null for shared/REST/config fences.
 * Resolution order matters: label, then language tag, then section heading.
 */
export function ownerOf(fence) {
  const label = (fence.label || '').toLowerCase();

  if (label) {
    if (SHARED_FENCES.labels.some((l) => l.toLowerCase() === label)) return null;
    for (const [id, s] of Object.entries(SDKS)) {
      if (s.fenceLabels.some((l) => l.toLowerCase() === label)) return id;
    }
    // A filename label (send_email.rb, SendEmail.php) falls through to the
    // language tag below, which is the reliable signal for those.
  }

  if (SHARED_FENCES.langs.includes(fence.lang)) return null;

  for (const [id, s] of Object.entries(SDKS)) {
    if (s.fenceLangs.includes(fence.lang)) return id;
  }

  // Unlabelled ```bash under a "## Go" heading in quickstart/installation.mdx.
  if (fence.lang === 'bash' && fence.h2) {
    for (const [id, s] of Object.entries(SDKS)) {
      if (s.installSection.toLowerCase() === fence.h2.toLowerCase()) return id;
    }
  }

  return null;
}

/**
 * Stable identity for a fence, so the guard survives INSERTION of a new fence.
 * A positional ordinal would shift every sibling and report false changes.
 */
export function fenceKeys(fences) {
  const seen = new Map();
  const out = new Map();
  for (const f of fences) {
    const base = `${f.group}|${f.h2 ?? ''}|${f.lang}|${f.label}`;
    const dup = (seen.get(base) ?? -1) + 1;
    seen.set(base, dup);
    out.set(`${base}|${dup}`, f);
  }
  return out;
}
