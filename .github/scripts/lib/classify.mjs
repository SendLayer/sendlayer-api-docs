/**
 * Tier classification: the one decision that drives every downstream file.
 * Deliberately explicit and LLM-free.
 *
 *   abort           prerelease/draft/non-semver. No PR.
 *   changelog-only  1 file.   Matches PR #23 (Node v1.0.2).
 *   surface         2-4 files. Most future releases.
 *   sweep           ~10 files. Matches PR #28 (Go v1.0.0).
 *
 * Two deliberate asymmetries:
 *
 * 1. docsMentions can UPGRADE changelog-only -> surface. A pure bugfix still
 *    needs a docs edit when the docs currently DESCRIBE the bug. Real example:
 *    PHP 1.1.0 fixed "passing both html and text drops the plain-text body",
 *    and sdks/php/introduction.mdx still tells readers they can pass both.
 *
 * 2. sweep is OVER-triggered on purpose. A false sweep costs a reviewer some
 *    minutes; a false changelog-only ships stale code samples to every reader.
 *    Asymmetric costs, asymmetric threshold.
 */

export function semverBump(prev, next) {
  const p = String(prev || '').replace(/^v/, '').split('.').map(Number);
  const n = String(next || '').replace(/^v/, '').split('.').map(Number);
  if (!n.length || Number.isNaN(n[0])) return 'unknown';
  if (!p.length || Number.isNaN(p[0])) return 'major';
  if (n[0] !== p[0]) return 'major';
  // 0.x -> 1.0.0 is major, handled above. A 0.x minor is treated as major
  // because pre-1.0 minors are conventionally allowed to break.
  if (p[0] === 0 && n[1] !== p[1]) return 'major';
  if (n[1] !== p[1]) return 'minor';
  return 'patch';
}

export function classify({ release = {}, version, prevVersion, signals = {} }) {
  if (release.isPrerelease || release.draft) return { tier: 'abort', why: 'prerelease or draft release' };
  if (!/^\d+\.\d+\.\d+$/.test(String(version || '').replace(/^v/, ''))) {
    return { tier: 'abort', why: `not a stable semver version: ${version}` };
  }

  const bump = signals.semverBump ?? semverBump(prevVersion, version);
  const sym = signals.publicSymbolDelta ?? { added: [], removed: [], signatureChanged: [] };
  const par = signals.paramDelta ?? { added: [], removed: [], nowRequired: [], nowOptional: [] };
  const mentions = signals.docsMentions ?? [];

  const reasons = [];
  if (bump === 'major') reasons.push('major version bump');
  if (signals.breakingText) reasons.push('breaking-change text in the release notes or changelog');
  if (sym.removed?.length) reasons.push(`${sym.removed.length} public symbol(s) removed`);
  if (sym.signatureChanged?.length) reasons.push(`${sym.signatureChanged.length} signature(s) changed`);
  if (par.removed?.length) reasons.push(`${par.removed.length} parameter(s) removed`);
  if (par.nowRequired?.length) reasons.push(`${par.nowRequired.length} parameter(s) became required`);
  if (reasons.length) return { tier: 'sweep', why: reasons.join('; '), semverBump: bump };

  if (!signals.apiSurfaceTouched) {
    // The bug-described-in-docs upgrade still applies.
    if (mentions.length) {
      return { tier: 'surface', semverBump: bump,
        why: `no API surface change, but ${mentions.length} page(s) mention a changed symbol` };
    }
    return { tier: 'changelog-only', why: 'no public API surface files changed', semverBump: bump };
  }

  if (bump === 'patch'
      && !sym.added?.length
      && !par.added?.length
      && !signals.docSignals
      && !mentions.length) {
    return { tier: 'changelog-only', semverBump: bump,
      why: 'patch release with no new symbols, no new params, no example/README churn and no docs mentions' };
  }

  const detail = [];
  if (sym.added?.length) detail.push(`${sym.added.length} new symbol(s)`);
  if (par.added?.length) detail.push(`${par.added.length} new param(s)`);
  if (signals.docSignals) detail.push('examples or README changed');
  if (mentions.length) detail.push(`${mentions.length} page(s) mention a changed symbol`);
  return { tier: 'surface', semverBump: bump, why: detail.join('; ') || 'API surface files changed' };
}

/** Tier -> the exact set of files this release may touch. */
export function allowlistFor({ tier, sdk, mentions = [], glob }) {
  const changelog = ['changelog.mdx'];
  if (tier === 'changelog-only') return changelog;

  if (tier === 'surface') {
    return [...new Set([...changelog, `${sdk.mainPage}.mdx`, ...mentions])];
  }

  // sweep: the language's whole spread, all guides, both quickstart pages.
  return [...new Set([
    ...changelog,
    ...glob(`${sdk.pageDir}/*.mdx`),
    ...glob('guides/*.mdx'),
    'quickstart/introduction.mdx',
    'quickstart/installation.mdx',
  ])];
}
