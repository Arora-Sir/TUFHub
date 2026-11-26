/**
 * TUFHub Utilities & Constants
 * Author: Mohit Arora (@Arora-Sir)
 */

// Must stay in sync with manifest.json content_scripts[].matches for valid takeuforward.org routes (practice problems, quiz sets, learning articles).
// Shared utility constant to prevent duplicate regex patterns across background.js and popup.js.
export const TUF_CONTENT_SCRIPT_URL = /^https:\/\/(?:[a-z0-9-]+\.)*takeuforward\.org\/(practice|practice-test|learning)\//i;

// URL segments TUF uses as redirect buckets for saved-list items (/practice/<container>/<slug>?list=...), never as a problem's own track.
// NOTE: Every item of an SQL saved list redirects through contentType "core-subject" (confirmed live on 2026-11-25), so the segment says nothing about the track.
export const CONTAINER_TRACK_SEGMENTS = ['core-subject'];

// Accepts a URL segment ('core-subject') or the category folder name built from it ('Core-Subject').
export function isContainerSegment(segment) {
  return CONTAINER_TRACK_SEGMENTS.includes(String(segment || '').toLowerCase());
}

// Sheet syllabus key per track, fetched when a problem is opened outside its own sheet page and the page never loads that syllabus itself.
export const KNOWN_TRACK_SYLLABUS_KEYS = {
  sql: 'sql---75-frequently-asked-interview-questions'
};

/**
 * TUF's revamped site tags problems Basic / Core / Pro instead of the classic Easy / Medium / Hard.
 * Bridges both vocabularies to a unified bucket so existing and newly synced problems tally and color-code together.
 * Falls back to 'unspecified' if neither vocabulary matched (e.g. problems without difficulty tier badges).
 */
export function classifyDifficulty(diffStr) {
  const d = (diffStr || '').toString().trim().toLowerCase();
  if (!d || d === 'unspecified') return 'unspecified';
  if (d.includes('easy') || d === 'basic') return 'easy';
  if (d.includes('hard') || d === 'pro' || d === 'advanced') return 'hard';
  if (d.includes('medium') || d === 'core') return 'medium';
  return 'unspecified';
}

export const LANGUAGE_MAP = {
  'C++': 'cpp',
  cpp: 'cpp',
  '1': 'cpp',
  '2': 'c',
  C: 'c',
  '3': 'py',
  Python: 'py',
  Python3: 'py',
  python: 'py',
  '4': 'js',
  JavaScript: 'js',
  javascript: 'js',
  '5': 'ts',
  TypeScript: 'ts',
  typescript: 'ts',
  '6': 'go',
  Go: 'go',
  golang: 'go',
  '7': 'java',
  Java: 'java',
  java: 'java',
  '8': 'rs',
  Rust: 'rs',
  rust: 'rs',
  'C#': 'cs',
  csharp: 'cs',
  SQL: 'sql',
  sql: 'sql',
  mysql: 'sql',
  postgresql: 'sql',
  sqlite: 'sql',
  oracle: 'sql',
  // Lowercase aliases and Monaco language ids, since callers look languages up case-insensitively and the editor reports ids like 'cpp', 'python', 'csharp'.
  'c++': 'cpp',
  c: 'c',
  python3: 'py',
  go: 'go',
  'c#': 'cs',
  pgsql: 'sql',
  // Bare extensions round-trip to themselves because the DOM language scan reports 'py', 'js', 'ts', 'cs', 'rs' directly.
  py: 'py',
  js: 'js',
  ts: 'ts',
  cs: 'cs',
  rs: 'rs'
};

/**
 * Resolves the solution file extension from whatever language identifier the judge, Monaco, or a DOM scan produced.
 * Accepts display names ('Java'), Monaco ids ('cpp'), numeric judge ids ('7'), and bare extensions ('py').
 * Falls back to the category default so a SQL answer never lands as a .cpp file.
 */
export function extensionForLanguage(language, category) {
  const raw = language == null ? '' : String(language).trim();
  const ext = LANGUAGE_MAP[raw] || LANGUAGE_MAP[raw.toLowerCase()];
  if (ext) return ext;
  return category === 'SQL' ? 'sql' : 'cpp';
}

// Readable fallback title built from the URL slug, used only when neither TUF's API nor the page h1 supplied one.
export function titleFromSlug(slug) {
  if (!slug) return '';
  return slug
    .split('-')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Drops UI-state params (open panel, saved list, sidebar toggle) so a saved problem link does not depend on how the problem was opened at submit time.
export function stripUiQueryParams(url) {
  try {
    const parsed = new URL(url);
    ['tab', 'list', 'sidebar'].forEach(param => parsed.searchParams.delete(param));
    return parsed.toString();
  } catch (e) {
    return url || '';
  }
}

export function convertToSlug(title) {
  if (!title) return 'unknown-problem';
  let slug = title
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-');
  return slug;
}

export function addLeadingZeros(slug) {
  const match = slug.match(/^(\d+)-(.*)/);
  if (match) {
    const num = match[1].padStart(4, '0');
    return `${num}-${match[2]}`;
  }
  return slug;
}

export function sanitizePathSegment(segment) {
  if (!segment) return 'General';
  // Hyphenate slashes first (e.g. DOM-scraped labels like "Sliding Window / 2 Pointer") to prevent unintended nested directories.
  // Then strip remaining special characters and normalize whitespace.
  let cleaned = segment
    .toString()
    .replace(/\s*[\/\\]\s*/g, '-')
    .replace(/[()?:*<>"|]/g, '')
    .replace(/\s+/g, '-')
    .trim();

  if (cleaned.length === 0 || cleaned.length > 50) return 'General';
  return cleaned;
}

/**
 * Derives filename for a synced solution (e.g. "Solution-1.cpp", "Optimal.java").
 * Diverges from legacy "solution.<ext>" whenever the active tab carries a custom name, whether that tab is alone or one of several, since a rename is always a deliberate signal worth keeping.
 * An unrenamed default tab ("Tab-1") keeps "solution.<ext>" while alone or maps to "Solution-1" once a second tab exists, while a custom name ("Optimal") is preserved verbatim either way.
 */
export function deriveCodeFileName(tabLabel, tabCount, ext) {
  if (!tabCount || !tabLabel) return `solution.${ext}`;
  const m = tabLabel.match(/^Tab-(\d+)$/i);
  if (tabCount < 2) return m ? `solution.${ext}` : `${sanitizePathSegment(tabLabel)}.${ext}`;
  const base = m ? `Solution-${m[1]}` : sanitizePathSegment(tabLabel);
  return `${base}.${ext}`;
}

/**
 * Display label for solution files in the root README Solution(s) column.
 * An unrenamed single tab retains the bare extension label (e.g. "JAVA") for repository continuity, but a custom name on that same lone tab is shown verbatim instead, exactly like a renamed tab alongside others.
 */
export function deriveFileLabel(tabLabel, tabCount, ext) {
  if (!tabCount || !tabLabel) return ext.toUpperCase();
  const m = tabLabel.match(/^Tab-(\d+)$/i);
  if (tabCount < 2) return m ? ext.toUpperCase() : sanitizePathSegment(tabLabel);
  return m ? `Solution-${m[1]}` : sanitizePathSegment(tabLabel);
}

/**
 * Normalizes root README date stamps before comparing against existing repository content.
 * NOTE: generateRootReadmeMarkdown() stamps today's date into the Last Synced column on each run.
 * NOTE: Naive string comparison would detect false-positive diffs once a day rolls over even with zero problem changes.
 * NOTE: Stripping the date cell keeps unchanged indexes out of commits; actual writes still preserve authentic dates.
 */
export function normalizeReadmeForCompare(content) {
  if (!content) return '';
  return content.replace(/`\d{4}-\d{2}-\d{2}`/, '`DATE`');
}

/**
 * Percent-encodes each segment of a repo-relative path for a Markdown link destination.
 * NOTE: encodeURIComponent leaves ( and ) alone, and TUF slugs such as "most-frequently-ordered-product(s)-for-each-customer" carry them.
 * NOTE: A raw parenthesis is legal on GitHub only while balanced, and any lazy link reader stops at the first ), so both are always encoded here.
 */
export function encodeRepoPath(path) {
  return String(path || '')
    .split('/')
    .map(segment => encodeURIComponent(segment).replace(/\(/g, '%28').replace(/\)/g, '%29'))
    .join('/');
}

/**
 * Reads every [text](href) Markdown link in a string, matching parentheses inside the destination by depth.
 * Returns hrefs exactly as written, so callers decide whether to decode them.
 * NOTE: A lazy /\[(.*?)\]\((.*?)\)/ stops at the first ), which turned "product(s)-for-each-customer" into a phantom "product(s" problem (BUG-019).
 * NOTE: An unbalanced destination is skipped rather than truncated, so a broken row is never read back as a real problem.
 */
export function parseMarkdownLinks(text) {
  const s = String(text || '');
  const links = [];
  let from = 0;
  while (from < s.length) {
    const mid = s.indexOf('](', from);
    if (mid === -1) break;
    const open = s.lastIndexOf('[', mid);
    let depth = 1;
    let end = mid + 2;
    for (; end < s.length && depth > 0; end++) {
      if (s[end] === '(') depth++;
      else if (s[end] === ')') depth--;
    }
    if (depth !== 0) break;
    if (open >= from) links.push({ text: s.slice(open + 1, mid), href: s.slice(mid + 2, end - 1) });
    from = end;
  }
  return links;
}

/**
 * Decodes a repo-relative link destination back to its raw path, segment by segment, tolerating malformed escapes.
 * NOTE: Decodes up to three times, because a v2.4.0 build that read an encoded link without decoding wrote "%28" back as "%2528", and that row must still resolve to the real folder.
 * NOTE: Repo folder names never contain a literal %, so repeated decoding cannot corrupt a real name.
 */
export function decodeRepoPath(href) {
  return String(href || '')
    .replace(/^\.\//, '')
    .split('/')
    .map(segment => {
      let out = segment;
      for (let i = 0; i < 3 && out.includes('%'); i++) {
        try {
          const next = decodeURIComponent(out);
          if (next === out) break;
          out = next;
        } catch (e) {
          break;
        }
      }
      return out;
    })
    .join('/');
}

export function encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

export function decode(str) {
  return decodeURIComponent(escape(atob(str)));
}

// Matches short keywords (bst, dp, lca, bfs, dfs, xor, bit, ll) at the start of a token rather than as an arbitrary substring.
// Left-boundary regex ensures suffixed forms like "bits" still match while preventing substring collisions.
// NOTE: Bare substring checks produced false positives, such as "sub-BST-rings" matching bst and "a-LL-three-characters" matching ll.
// NOTE: Longer keywords retain substring checks because their collision risk is negligible and legitimate substrings like "substring" must match.
export function hasToken(text, token) {
  return new RegExp('\\b' + token).test(text);
}

// Full word-boundary matcher for tokens that form prefixes of unrelated common words.
// For example, a left-boundary check for "lis" incorrectly matches "todo-LIST" because "lis" begins "list".
// Exact word boundary matching is safe here because "lis" has no valid suffixed forms.
export function hasExactToken(text, token) {
  return new RegExp('\\b' + token + '\\b').test(text);
}

export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Runs fn over items with at most `limit` in flight at once, preserving input order in the result.
// NOTE: A bare Promise.all over dozens of items fires every request at the same instant, which is fine against GitHub's own generous rate limit but is exactly the kind of burst a smaller third-party site (or GitHub's undocumented secondary abuse limits) can react badly to.
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
