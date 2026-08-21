# SDK release → docs PR pipeline

When an SDK publishes a release, `.github/workflows/sdk-release-docs.yml` opens a
reviewed PR updating the docs surfaces that release actually touched. Nothing
merges automatically.

## Five constraints that would silently break the obvious design

Each of these fails with **no error anywhere**, so they are documented first.

1. **`on: release: published` never fires in the SDK repos.** All five create
   their release with `softprops/action-gh-release` authenticated by
   `GITHUB_TOKEN`, and `GITHUB_TOKEN`-created events do not start workflow runs.
   Verified: every release in `sendlayer-node` and `sendlayer-go` is authored
   `github-actions[bot]`. The sender is therefore a `needs:`-chained job inside
   the existing `publish.yaml`, not a release-triggered workflow.
2. **A PR created with `GITHUB_TOKEN` gets zero CI.** This repo's `vale.yml`,
   `spectral.yml` and `broken-link-checker.yml` are all `pull_request`-triggered.
   The PR must be created with `DOCS_PR_TOKEN`, a PAT.
3. **`reviewers:` on a self-authored PR returns 422** and
   `peter-evans/create-pull-request` only logs a warning. Use `assignees:`.
4. **`create-pull-request` hard-resets its branch**, destroying human commits
   pushed to it. `plan` refuses to proceed when the branch carries non-bot
   commits unless `force: true`.
5. **Vale here runs `fail_on_error: false` and `main` has no branch protection.**
   Nothing downstream can stop a broken page, so the pipeline's own blocking gate
   job is the real control.

## Layout

```
lib/sdk-registry.mjs     the ONE table: paths, fence labels, version + floor
                         readers, symbol patterns. Nothing else names a language.
lib/mdx.mjs              frontmatter split + fence parser + fence ownership
lib/classify.mjs         tier decision and tier -> allowlist
lib/known-gaps.json      baselined pre-existing violations, each with an expiry
lib/symbol-stoplist.txt  identifiers that are not SDK API (plus known real bugs)

release-context.mjs      gather, classify, emit context.json + tasks.md
changelog-entry.mjs      the ONLY writer of changelog.mdx
reconcile-floors.mjs     documented runtime floors vs each SDK's manifest
nav-insert.mjs           docs.json mutation helper the agent calls
vocab-add.mjs            append-only Vale vocabulary helper

gates/run-all.mjs        orchestrator: --stage=agent | --stage=final
gates/*.mjs              11 gates, cheapest first
```

## The deterministic / agentic seam

The seam is **structure vs. sentence**, not "small release vs. big release".

| Deterministic owns | Agent owns |
|---|---|
| Which files may be touched | Every English sentence |
| The `<Update>` wrapper, label, description, indentation, insert offset | Every line of example code |
| `docs.json` nav mutation | Which in-scope files actually need changes |
| Runtime-floor literals | Changelog prose, emitted as JSON data |
| Every gate | — |

Two findings that shaped this:

- **There are no version pins to bump.** Every install command in the docs is
  unpinned. The only version literals are `changelog.mdx`'s `description="v…"`
  and the out-of-scope OpenAPI `info.version`. The deterministic half's real jobs
  are the `<Update>` structure and floor reconciliation.
- **There is no LLM-free fast path, even for a patch.** `sendlayer-node` v1.0.2's
  release body is `* v1.0.2 - compatibility release`. The docs sentence it became
  is not derivable from that.

**Consequence: the agent never edits `changelog.mdx`.** It writes `summary.json`;
`changelog-entry.mjs` splices the block; the `changelog-render` gate asserts the
file byte-matches that render. That converts the repo's most history-dense file
from "hope the model indented correctly" into a byte-equality assertion.

### changelog.mdx byte invariants

Verified against the live file; each one matters:

- frontmatter is `---\ntitle\ndescription\nrss: true\n---\n\n`, first `<Update`
  at byte offset 91
- body lines indented **exactly 2 spaces**; blank lines **truly empty**
- `**Before**` / `**After**` are followed **immediately** by their fence, no
  blank line
- **the file has no trailing newline** — which is why the renderer splices a raw
  string at a byte offset instead of round-tripping through
  `split('\n')`/`join('\n')`; a naive rewrite appends a byte and produces a
  spurious final-line hunk on every run

## Tiers

| Tier | Files | Trigger |
|---|---|---|
| `abort` | 0 | prerelease, draft, or non-`x.y.z` |
| `changelog-only` | 1 | no API surface change, or a patch with no new symbols/params and no docs mentions |
| `surface` | 2–4 | API surface touched, or a page mentions a changed identifier |
| `sweep` | ~10 | major bump, removed/renamed symbol, removed/newly-required param, or breaking-change text |

Two deliberate asymmetries:

- `docsMentions` can **upgrade** `changelog-only → surface`: a pure bugfix still
  needs an edit when the docs currently *describe the bug*.
- `sweep` **over-triggers on purpose**. A false sweep costs review minutes; a
  false `changelog-only` ships stale samples to every reader.

The allowlist is a **permission, not a checklist**. Identifier matching is
fail-safe, so a generic token (`text`, `from`) pulls in more pages than need
editing. Leaving a listed file untouched because it is still correct is a good
outcome, and `tasks.md` says so explicitly.

## Gates

Blocking, cheapest first: `scope`, `frontmatter`, `mdx-parse`, `fence`, `symbol`,
`placeholder`, `nav`, `link`, `snippets`, `vale`, and `changelog-render`
(`--stage=final` only).

Two carry most of the weight:

- **`fence`** — sibling CodeGroup fences must be byte-identical. Identity is
  `(codegroup#, section, lang, label, duplicate-index)`, never a positional
  ordinal, so it survives fence insertion. Verified unique across all 300 fences.
  A dup-index shift can only ever affect fences the releasing SDK already owns,
  because lang/label decides ownership.
- **`symbol`** — every identifier written into a fence must be greppable in the
  SDK source at that tag. This mechanises "never invent an API" and is why prompt
  injection cannot fabricate one: the fabrication would have to already exist in
  shipped source. It refuses to run against an empty haystack rather than
  flagging everything.

**Vale mostly does not block.** Measured, not guessed: only `Vale.Spelling`,
`Vale.Terms`, `Vale.Repetition` and `SendLayer.DisAllow` are error level;
`HeadingTitleCase`, `BrandWords`, `DeveloperVoice`, `FirstPerson`,
`SentenceLength` and `Readability` are warning or suggestion. This repo's own CI
runs `fail_on_error: false`, and a local gate stricter than the repo's own policy
stalls on subjective style — a stalling pipeline gets switched off.

`nav` and `link` are **baseline-diffed** via `lib/known-gaps.json`. Every entry
has an `expires` date, after which the finding escalates to blocking, so the debt
cannot rot silently.

## Prompt injection

Release notes, PR titles, commit messages and code comments come from repos other
people can write to, and `generate_release_notes` interpolates PR titles
verbatim. Six layers, in order of how much they actually protect:

1. **Capability containment is the real defence.** No network tool, no VCS write,
   write scope limited to four doc directories. The worst an injected instruction
   achieves is a bad in-scope edit a human then reviews.
2. Untrusted text is written to `untrusted/*.md` and referenced **by path**, so
   it arrives as tool output rather than instruction.
3. A narrow role-marker sanitiser, as defence in depth. A filter is a filter.
4. A prompt section naming the attack with concrete refusals.
5. **Scope is machine-decided** before the model runs and enforced after.
6. `symbol` pins every factual API claim to shipped source.

## Running it

```bash
# Dry run — artifacts and a step-summary diff, no PR, nothing touched.
gh workflow run sdk-release-docs.yml --repo SendLayer/sendlayer-api-docs \
  -f sdk=node -f version=1.0.3 -f dry_run=true

# Locally: classify and build the work order.
node .github/scripts/release-context.mjs --sdk node --version 1.0.3 \
  --out /tmp/rel --sdk-root ../sendlayer-node

# Locally: run the gates.
node .github/scripts/gates/run-all.mjs --stage=final --context /tmp/rel/context.json

# Floor drift report.
node .github/scripts/reconcile-floors.mjs --sdk-roots ../..
```

`repository_dispatch` always runs the **default-branch** copy of the workflow, so
a receiver on a feature branch is unreachable and produces no run and no error.
`workflow_dispatch` is the only way to test a change on a branch.

## Secrets

| Secret | Where | Scope |
|---|---|---|
| `ANTHROPIC_API_KEY` | this repo | — |
| `DOCS_PR_TOKEN` | this repo | fine-grained PAT, `sendlayer-api-docs` only, Contents RW + Pull requests RW + Metadata R |
| `DOCS_DISPATCH_TOKEN` | each SDK repo | fine-grained PAT, `sendlayer-api-docs` only, Contents write + Metadata R |

## Adding an SDK

1. Add an entry to `lib/sdk-registry.mjs`.
2. Copy the `docs-dispatch` job into that repo's publish workflow, changing only
   `SDK_ID`, and add `outputs.version` to the job that computes the version.
3. Set `DOCS_DISPATCH_TOKEN` there.
4. Dry-run the receiver before wiring the sender.

Copy-paste is deliberate for the sender: a shared `workflow_call` workflow still
needs the secret in each repo, so it dedupes YAML but not setup, and it couples
all five release pipelines to one file. Promote to a composite action at 9+
senders.
