/**
 * The one table the docs pipeline keys off. Nothing else may hardcode a
 * language, a page path, or a fence label.
 *
 * Fields:
 *   repo              GitHub repo that ships this SDK.
 *   changelogHeading  Canonical `### ` heading inside an <Update> block.
 *                     changelog.mdx is inconsistent today ("Go SDK" in the
 *                     Oct 2025 entry vs "Golang SDK" in Mar 2026). This is the
 *                     tiebreaker; `changelogAliases` is what the idempotency
 *                     check matches so a legacy heading still counts as
 *                     "already documented".
 *   docsGroup         Group label in docs.json navigation.
 *   mainPage          Primary SDK page, without the .mdx extension. Note
 *                     node/python/php use `introduction`, ruby/go do not.
 *   pageDir           Directory holding this SDK's pages.
 *   installSection    `## ` heading in quickstart/installation.mdx. Used to
 *                     resolve ownership of unlabelled ```bash install fences.
 *   fenceLangs        Fence language tags this SDK owns.
 *   fenceLabels       Fence labels this SDK owns (matched case-insensitively).
 *   apiSurface        Globs whose change implies the public API may have moved.
 *   groundTruth       Globs the symbol gate greps to prove an identifier exists.
 *   version           Where the released version is declared, and how to read it.
 *   floor             Where the runtime floor is declared. `null` reader result
 *                     means the SDK does not declare one (node has no engines).
 */

const json = (t) => JSON.parse(t);
const firstMatch = (re) => (t) => t.match(re)?.[1] ?? null;

export const SDKS = {
  node: {
    repo: 'SendLayer/sendlayer-node',
    changelogHeading: 'Node.js SDK',
    changelogAliases: ['Node.js SDK', 'Node SDK', 'NodeJS SDK'],
    docsGroup: 'JavaScript',
    mainPage: 'sdks/nodejs/introduction',
    pageDir: 'sdks/nodejs',
    installSection: 'Node.js',
    fenceLangs: ['javascript', 'js', 'typescript', 'ts'],
    fenceLabels: ['JavaScript', 'Node.js', 'npm', 'yarn', 'pnpm'],
    apiSurface: ['src/**/*.ts', 'package.json'],
    apiSurfaceExclude: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    groundTruth: ['src/**', 'examples/**', 'tests/**', 'README.md', 'package.json'],
    version: { path: 'package.json', read: (t) => json(t).version },
    floor: { path: 'package.json', read: (t) => json(t).engines?.node ?? null, label: 'Node.js' },
    symbolPatterns: [/\bsendlayer\.([A-Z]\w*)\.(\w+)\s*\(/g],
    // `?` captures TypeScript OPTIONAL properties (`text?: string`). Without it
    // an optionality change is invisible, and optionality drives the Required
    // column of every Email Parameters table in the docs. Real case: node
    // v1.0.3 made `text` optional in EmailOptions and the naive pattern
    // detected nothing at all.
    paramPatterns: [/^\s*(\w+)\??:\s/gm],
  },

  python: {
    repo: 'SendLayer/sendlayer-python',
    changelogHeading: 'Python SDK',
    changelogAliases: ['Python SDK'],
    docsGroup: 'Python',
    mainPage: 'sdks/python/introduction',
    pageDir: 'sdks/python',
    installSection: 'Python',
    fenceLangs: ['python'],
    fenceLabels: ['Python', 'pip'],
    apiSurface: ['src/sendlayer/**/*.py', 'pyproject.toml'],
    apiSurfaceExclude: [],
    groundTruth: ['src/**', 'examples/**', 'tests/**', 'README.md', 'pyproject.toml'],
    version: { path: 'src/sendlayer/VERSION', read: (t) => t.trim() },
    floor: {
      path: 'pyproject.toml',
      read: firstMatch(/^requires-python\s*=\s*["']([^"']+)/m),
      label: 'Python',
    },
    symbolPatterns: [/\bsendlayer\.([A-Z]\w*)\.(\w+)\s*\(/g],
    // Python's Emails.send() takes `sender=`, not `from=` -- `from` is a keyword.
    paramPatterns: [/^\s*(\w+)\s*=/gm, /["'](\w+)["']\s*:/g],
  },

  php: {
    repo: 'SendLayer/sendlayer-php',
    changelogHeading: 'PHP SDK',
    changelogAliases: ['PHP SDK'],
    docsGroup: 'PHP',
    mainPage: 'sdks/php/introduction',
    pageDir: 'sdks/php',
    installSection: 'PHP',
    fenceLangs: ['php'],
    fenceLabels: ['PHP', 'composer'],
    apiSurface: ['src/**/*.php', 'composer.json'],
    apiSurfaceExclude: [],
    groundTruth: ['src/**', 'examples/**', 'tests/**', 'README.md', 'CHANGELOG.md', 'composer.json'],
    version: { path: 'composer.json', read: (t) => json(t).version },
    floor: { path: 'composer.json', read: (t) => json(t).require?.php ?? null, label: 'PHP' },
    symbolPatterns: [/\$\w+->([A-Z]\w*)->(\w+)\s*\(/g],
    paramPatterns: [/'(\w+)'\s*=>/g],
  },

  ruby: {
    repo: 'SendLayer/sendlayer-ruby',
    changelogHeading: 'Ruby SDK',
    changelogAliases: ['Ruby SDK'],
    docsGroup: 'Ruby',
    mainPage: 'sdks/ruby/send-with-ruby',
    pageDir: 'sdks/ruby',
    installSection: 'Ruby',
    fenceLangs: ['ruby'],
    fenceLabels: ['Ruby', 'gem', 'bundle', 'Gemfile'],
    apiSurface: ['lib/**/*.rb', 'sendlayer.gemspec'],
    apiSurfaceExclude: ['lib/sendlayer/version.rb'],
    groundTruth: ['lib/**', 'examples/**', 'spec/**', 'README.md', 'sendlayer.gemspec'],
    version: {
      path: 'lib/sendlayer/version.rb',
      read: firstMatch(/VERSION\s*=\s*['"]([^'"]+)/),
    },
    floor: {
      path: 'sendlayer.gemspec',
      read: firstMatch(/required_ruby_version\s*=\s*['"][^0-9]*([0-9.]+)/),
      label: 'Ruby',
    },
    // Ruby exposes lowercase emails/webhooks/events; the other four capitalize.
    symbolPatterns: [/\b\w+\.([a-z]\w*)\.(\w+)/g],
    paramPatterns: [/^\s*(\w+):\s/gm],
  },

  go: {
    repo: 'SendLayer/sendlayer-go',
    changelogHeading: 'Go SDK',
    // The Mar 2026 entry says "Golang SDK". Kept so the idempotency check does
    // not report a false negative and emit a duplicate entry.
    changelogAliases: ['Go SDK', 'Golang SDK'],
    docsGroup: 'Go',
    mainPage: 'sdks/go/send-with-go',
    pageDir: 'sdks/go',
    installSection: 'Go',
    fenceLangs: ['go'],
    fenceLabels: ['Go'],
    apiSurface: ['*.go', 'go.mod'],
    apiSurfaceExclude: ['*_test.go', 'examples/**'],
    groundTruth: ['*.go', 'examples/**', 'tests/**', 'README.md', 'CHANGELOG.md', 'go.mod'],
    version: { path: '.github/VERSION', read: (t) => t.trim() },
    floor: { path: 'go.mod', read: firstMatch(/^go\s+(\S+)/m), label: 'Go' },
    symbolPatterns: [/\b\w+\.([A-Z]\w*)\.(\w+)\s*\(/g, /\bsendlayer\.([A-Z]\w*)\{/g],
    paramPatterns: [/^\s*([A-Z]\w*):\s/gm],
  },
};

/** Fence labels and langs that belong to no SDK and must never be edited. */
export const SHARED_FENCES = {
  labels: ['cURL', 'curl', '.env'],
  langs: ['json', 'yaml', 'yml', 'text', 'txt', 'html', 'sql', 'diff'],
};

/** Doc surfaces the pipeline may write. Everything else is a scope violation. */
export const IN_SCOPE = ['changelog.mdx', 'sdks/', 'guides/', 'quickstart/'];

/** Never writable, even by an explicit task. */
export const DENIED = [
  'snippets/',
  'api-reference/',
  '.github/scripts/',
  '.github/workflows/',
  '.github/styles/SendLayer/',
  '.vale.ini',
  '.spectral.yaml',
  '.cursor/',
];

/** Per-path diff budget. Calibrated against PR #28's real churn. */
export const BUDGET = {
  // changelog.mdx is append-at-top-only by construction. ANY deletion is a
  // clobber of release history -- the strongest invariant in the pipeline.
  'changelog.mdx': { maxAdded: 120, maxDeleted: 0 },
  'docs.json': { maxChangedLines: 12 },
  'sdks/': { maxChangedPct: 40 },
  'guides/': { maxChangedLines: 60 },
  'quickstart/': { maxChangedLines: 40 },
  default: { maxChangedLines: 60 },
};

export function sdkOrDie(id) {
  const s = SDKS[id];
  if (!s) {
    const known = Object.keys(SDKS).join(', ');
    throw new Error(`unknown sdk id '${id}'. Known ids: ${known}`);
  }
  return { id, ...s };
}

export const SDK_IDS = Object.keys(SDKS);
