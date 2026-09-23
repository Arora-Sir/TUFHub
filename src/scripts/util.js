/**
 * TUFHub Utilities & Constants
 * Author: Mohit Arora (@Arora-Sir)
 */

// Must stay in sync with manifest.json content_scripts[].matches for valid takeuforward.org routes (practice problems, quiz sets, learning articles).
// Shared utility constant to prevent duplicate regex patterns across background.js and popup.js.
export const TUF_CONTENT_SCRIPT_URL = /^https:\/\/(?:[a-z0-9-]+\.)*takeuforward\.org\/(practice|practice-test|learning)\//i;

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
  oracle: 'sql'
};

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
 * Diverges from legacy "solution.<ext>" only when 2+ tabs exist to preserve multiple solution strategies.
 * Unrenamed tabs ("Tab-1") map to "Solution-1", while custom names ("Optimal") are preserved verbatim.
 */
export function deriveCodeFileName(tabLabel, tabCount, ext) {
  if (!tabCount || tabCount < 2 || !tabLabel) return `solution.${ext}`;
  const m = tabLabel.match(/^Tab-(\d+)$/i);
  const base = m ? `Solution-${m[1]}` : sanitizePathSegment(tabLabel);
  return `${base}.${ext}`;
}

/**
 * Display label for solution files in the root README Solution(s) column.
 * Single-tab problems retain the bare extension label (e.g. "JAVA") for repository continuity.
 */
export function deriveFileLabel(tabLabel, tabCount, ext) {
  if (!tabCount || tabCount < 2 || !tabLabel) return ext.toUpperCase();
  const m = tabLabel.match(/^Tab-(\d+)$/i);
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
