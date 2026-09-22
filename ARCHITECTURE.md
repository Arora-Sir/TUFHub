# TUFHub Architecture

This is the mental model a newcomer (human or AI) needs before changing code here. It covers the structure and the non-obvious decisions behind it, not a line-by-line tour: read the source for that. Nothing here should duplicate what a comment can say better at the point it matters; this is for the shape of the system, not its details.

## What this is

A Chrome extension (Manifest V3) that watches takeuforward.org for an accepted problem submission and commits the solution code straight to a GitHub repository, automatically, with a generated README per problem and a solved-problems index at the repo root.

## The two-world split, and why it constrains everything

Manifest V3 content scripts run in one of two JS realms on the same page:

- **MAIN world** (`interceptor.js`): shares the page's own `window`, so it can monkey-patch `fetch`/`XMLHttpRequest` to observe TUF's own API traffic, and read `window.monaco` directly for editor content. It has no access to `chrome.*` extension APIs.
- **ISOLATED world** (`content.js`): has `chrome.*` APIs (storage, runtime messaging) but a separate JS environment from the page: it cannot see variables or call functions defined in MAIN world, even though both are injected into the same tab.

They talk to each other only through `CustomEvent` instances dispatched on `document` (`TUFHUB_ACCEPTED_SUBMISSION`, `TUFHUB_USER_SUBMIT_CLICKED`, `TUFHUB_DIAG`, ...): there is no shared module between them. This is why some logic (extracting the active tab's name, reading Monaco's code, computing the routing hierarchy) exists as near-duplicate implementations in both files rather than one shared function: MAIN world genuinely cannot `import` from ISOLATED world's modules, and vice versa is not worth the indirection for logic that is cheap to keep in sync by hand. `router.js`'s `resolveHierarchy()` is the one exception; it is ISOLATED-world-only (bundled into `content.js`), because routing only ever needs to run once, at actual sync time, in the world that has `chrome.storage` to write the result to.

## Two detection channels, on purpose

A verdict can be observed two ways: `interceptor.js` sees TUF's own API response carrying the verdict (the primary, fast path), or `content.js` polls the DOM for accepted-verdict text as a backup. Both exist because the primary path is inherently fragile against a moving target: TUF's API endpoints and response shapes are not a contract this project controls, and a new site revamp can silently start returning a shape the interceptor does not recognize, or introduce an endpoint that is not in the allowlist yet (see `background.js`'s endpoint allowlist and the `UNMATCHED_ENDPOINT` diagnostic events it logs when something new shows up unrecognized). The DOM-text backup is slower but reads only rendered text, which is far less likely to change shape invisibly. Neither channel is "the real one"; whichever fires first wins, and both are kept correct independently rather than one deferring to the other.

Both channels snapshot the active tab's code and name at the instant Submit is clicked, not when the verdict arrives: a slow judge (SQL polling in particular) gives enough time for a user to switch tabs before the verdict lands, and a live re-scrape at that point would read the wrong tab's code.

## Routing: `router.js`

`classifyPath()` recognizes any `/practice/<subject>/<slug>` URL generically. Adding a future TUF subject (an HLD sheet, for example) needs no code change, just a folder name it will pick up from the URL's own subject segment. Anything that is not a syncable problem page (`/practice-test/`, `/learning/`, `/prep-hub/`) is recognized and explicitly skipped rather than falling through to a default category.

`resolveHierarchy()` has two genuinely different branches, and they differ because the two subjects' own site structure differs, not by inconsistency:

- **DSA** tries the sidebar's own expanded accordion trail first (`aria-expanded="true"` buttons, in DOM order from top-level category to specific sub-category), falling back to the URL's `category` query param only if the sidebar has not rendered yet. This is necessary because DSA's `category` param resolves to a fine-grained sub-group, not the curated ~18-topic convention this project has always used; using it directly fragments one shared topic folder into many narrow ones.
- **SQL** (and any other generic subject) uses the URL's `category` param directly as the only folder level. Verified against TUF's real sheet listing that SQL's taxonomy is genuinely flat (topic groups containing problems directly, no sub-level), so there is nothing finer to resolve. A previous version of this code tried to add a second, DOM-text-sniffed folder level here too; it was actively wrong, not just unnecessary.

The GitHub folder slug itself always comes from the URL's own last path segment, never from the page title. Deriving slugs from problem titles failed on SQL sheets where titles carry problem numbers (such as "47. Profitable Customers in 2021"), which mistakenly zero-padded leading numbers into folder names.

## Sync pipeline

A sync writes through GitHub's Git Data API directly (blob -> tree -> commit -> ref PATCH), not the simpler contents API, so a submission with multiple files (a multi-tab problem's several solutions plus its README) lands as one atomic commit instead of several. All GitHub writes (a sync, a reconcile, a delete) are funneled through one serialized queue (`enqueueGitHubWrite` in `background.js`) in the background service worker, so two writers (two open tabs, a manual Sync click landing mid-submission, a delete's own follow-up reconcile) can never race each other's ref updates. A ref-update conflict (GitHub's "not a fast forward", which happens under real contention even with serialization, since GitHub's own branch state can lag a commit that just landed) is retried with backoff inside `commitTreeEntries`, not surfaced to the user as a failure.

## Stats and reconcile: local cache, GitHub as source of truth

`stats.problems` in `chrome.storage.local` is a cache, not the record of truth: every field in it except title/difficulty/topic is meant to be correctable from GitHub's own state. `reconcileRepoFromTree` (the popup's "Sync" button, and automatically after every delete) walks the live repo tree and rebuilds this cache from what is actually there, including re-fetching each problem's real last-commit date from GitHub rather than trusting whatever `updatedAt` is already cached locally. This makes the cache self-healing against local corruption rather than merely correct at write time, avoiding historical bugs where local reconcile functions unconditionally stamped today's date onto all problems.

Duplicate detection groups repo folders by slug (the last path segment). A problem that used to sync to one folder and now syncs to a different one (after a routing fix, for example) leaves its old copy behind as an orphan, surfaced to the user as a duplicate rather than silently losing one copy.

## File map

- `src/scripts/tuf/interceptor.js`: MAIN world. Network interception, Monaco reads, verdict detection (primary channel).
- `src/scripts/tuf/content.js`: ISOLATED world. Everything else: routing, GitHub sync orchestration, the DOM-text backup detection channel, messaging to the background worker.
- `src/scripts/tuf/router.js`: URL/DOM to folder-path resolution. Pure functions, no side effects, easiest file to unit-reason about in isolation.
- `src/scripts/tuf/readme.js`: per-problem README generation (HTML to Markdown).
- `src/scripts/tuf/rootReadme.js`: repo-root solved-problems index generation.
- `src/scripts/tuf/stats.js`: local stats cache, the two reconcile functions, code-change hashing for dedup.
- `src/scripts/tuf/uploader.js`: the actual GitHub Git Data API calls (`commitTreeEntries`, `deleteFiles`, `uploadToGitHub`).
- `src/scripts/background.js`: service worker. The serialized write queue, message routing between popup/content script and the sync pipeline, install/update re-injection.
- `src/scripts/popup.js` / `src/popup.html`: the toolbar popup UI: auth, stats, Sync button, duplicate-folder panel.
