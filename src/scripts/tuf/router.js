/**
 * TUFHub Multi-Category Router
 * Author: Mohit Arora (@Arora-Sir)
 *
 * Dynamically resolves target repository path and hierarchy for code submissions across:
 * - DSA (Data Structures & Algorithms)
 * - SQL (SQL & Data Engineering)
 * - Design (OOPS / Low-Level Design, and any future design tracks)
 * - Generic: Any other /practice/<subject>/<slug> route picked up dynamically via classifyPath().
 *
 * Routes explicitly ignored and skipped (never mis-filed as DSA):
 * - /practice-test/<subject>/... (timed multi-question quiz sets without a single free-response problem)
 * - /learning/<subject>/... (video and editorial lesson pages without code editors)
 * - /prep-hub/... (sheet landing and overview pages)
 */

import { sanitizePathSegment } from '../util.js';

// Maps syllabus sidebar topic labels to canonical folder names for DSA problems.
// NOTE: Sidebar auto-highlights active category and sub-category paths on page load.
// NOTE: Sidebar state is more reliable than URL slug keyword sniffing because many slugs lack recognizable keywords.
// NOTE: Unmapped categories pass through as sanitized folder names rather than being dropped.
const SIDEBAR_TOPIC_MAP = {
  'sorting': 'Sorting',
  'arrays': 'Arrays',
  'hashing': 'Hashing',
  'binary search': 'Binary-Search',
  'recursion': 'Recursion',
  'linked-list': 'Linked-List',
  'bit manipulation': 'Bit-Manipulation',
  'greedy algorithms': 'Greedy',
  'sliding window / 2 pointer': 'Sliding-Window',
  'stack / queues': 'Stack-Queue',
  'binary trees': 'Trees',
  'binary search trees': 'Trees',
  'heaps': 'Heaps',
  'graphs': 'Graphs',
  'dynamic programming': 'Dynamic-Programming',
  'tries': 'Tries',
  'strings (advanced algo)': 'Strings',
  'maths': 'Maths'
};

// Category folder name overrides for URL segments where acronym capitalization is desired.
// Unlisted categories default to title-cased folder names (e.g. 'hld' becomes 'Hld').
const CATEGORY_NAME_OVERRIDES = {
  dsa: 'DSA',
  sql: 'SQL'
};

function titleCaseSlug(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('-');
}

function categoryNameFromSegment(segment) {
  const key = (segment || '').toLowerCase();
  return CATEGORY_NAME_OVERRIDES[key] || titleCaseSlug(segment);
}

function canonicalizeTopicLabel(label) {
  if (!label) return '';
  const key = label.toLowerCase().trim();
  return SIDEBAR_TOPIC_MAP[key] || label;
}

// Scrapes expanded accordion headers (aria-expanded="true") within SyllabusSidebarContent.
// The first expanded header represents the top-level topic, while subsequent headers represent subtopics.
function extractActiveSidebarTopic() {
  try {
    const expanded = Array.from(document.querySelectorAll('[class*="SyllabusSidebarContent"] button[aria-expanded="true"]'));
    return {
      mainLabel: expanded[0] ? expanded[0].textContent.trim() : '',
      subLabel: expanded.length > 1 ? expanded[expanded.length - 1].textContent.trim() : ''
    };
  } catch (e) {
    return { mainLabel: '', subLabel: '' };
  }
}

// Scrapes explicit subtopic keywords from page content for legacy problem pages.
// Problems without matching keywords fall back to a flat topic structure in resolveHierarchy.
function extractSubTopicFromDOM() {
  try {
    const bodyText = document.body.innerText || '';
    if (bodyText.includes('FAQs (Medium)') || bodyText.includes('FAQs Medium')) return 'FAQs-Medium';
    if (bodyText.includes('FAQs (Hard)') || bodyText.includes('FAQs Hard')) return 'FAQs-Hard';
    if (bodyText.includes('Fundamentals (Single LL)') || bodyText.includes('Fundamentals Single LL')) return 'Fundamentals-Single-LL';
    if (bodyText.includes('Fundamentals (Doubly LL)') || bodyText.includes('Fundamentals Doubly LL')) return 'Fundamentals-Doubly-LL';
    if (bodyText.includes('Logic Building')) return 'Logic-Building';
  } catch (e) {}
  return '';
}

function extractTopicFromPathname(pathname, ignoreKeywords = []) {
  try {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length === 0) return '';

    // Always ignore the last path segment as it is the problem slug itself
    const topicParts = parts.slice(0, -1);

    for (let i = topicParts.length - 1; i >= 0; i--) {
      const p = topicParts[i].toLowerCase();
      if (p === 'problems' || p === 'plus' || p === 'practice' || p === 'dsa' || p === 'sql' || p === 'aptitude' || ignoreKeywords.includes(p)) continue;

      return titleCaseSlug(topicParts[i]);
    }
  } catch (e) {}
  return '';
}

/**
 * Last-resort DSA topic guesser using problem title and URL heuristics.
 * NOTE: Preserved with identical keywords and priority order from prior versions.
 * NOTE: Used only when query parameters and sidebar DOM elements are unavailable.
 */
function dsaKeywordFallback(pathname, searchParams, data = {}) {
  const subjectParam = (searchParams.get('subject') || '').toLowerCase();
  const approachParam = (searchParams.get('approach') || '').toLowerCase();
  const titleOrUrl = (pathname + ' ' + (data.title || '') + ' ' + subjectParam + ' ' + approachParam).toLowerCase();

  // Backtracking is prioritized first as an explicit override because TUF embeds it within Recursion.
  const isBacktracking = (
    titleOrUrl.includes('backtracking') || titleOrUrl.includes('n-queens') ||
    titleOrUrl.includes('sudoku') || titleOrUrl.includes('word-search') ||
    titleOrUrl.includes('rat-in-a-maze') || titleOrUrl.includes('m-coloring') ||
    titleOrUrl.includes('palindrome-partitioning')
  );
  if (isBacktracking) return 'Backtracking';

  if (titleOrUrl.includes('linked-list') || titleOrUrl.includes('linkedlist') || titleOrUrl.includes('ll') || titleOrUrl.includes('reverse-a-list')) {
    return 'Linked-List';
  }
  if (titleOrUrl.includes('binary-search') || titleOrUrl.includes('search-in-sorted') || titleOrUrl.includes('search-insert')) {
    return 'Binary-Search';
  }
  if (
    titleOrUrl.includes('subsets') || titleOrUrl.includes('subset') ||
    titleOrUrl.includes('recursion') || titleOrUrl.includes('recursive') ||
    titleOrUrl.includes('combination') || titleOrUrl.includes('combinations') ||
    titleOrUrl.includes('permutation') || titleOrUrl.includes('permutations') ||
    titleOrUrl.includes('parentheses') || titleOrUrl.includes('parenthesis') ||
    titleOrUrl.includes('phone-number') || titleOrUrl.includes('phone number') ||
    titleOrUrl.includes('letter-combinations') || titleOrUrl.includes('letter combinations')
  ) {
    return 'Recursion';
  }
  if (
    titleOrUrl.includes('tree') || titleOrUrl.includes('bst') ||
    titleOrUrl.includes('inorder') || titleOrUrl.includes('preorder') || titleOrUrl.includes('postorder') ||
    titleOrUrl.includes('level-order') || titleOrUrl.includes('zigzag') || titleOrUrl.includes('boundary') ||
    titleOrUrl.includes('vertical-order') || titleOrUrl.includes('top-view') || titleOrUrl.includes('bottom-view') ||
    titleOrUrl.includes('diameter') || titleOrUrl.includes('lca') || titleOrUrl.includes('symmetric') ||
    titleOrUrl.includes('balanced-tree') || titleOrUrl.includes('maximum-depth') || titleOrUrl.includes('minimum-depth') ||
    titleOrUrl.includes('flatten') || titleOrUrl.includes('invert') || titleOrUrl.includes('path-sum') ||
    titleOrUrl.includes('root-to-node') || titleOrUrl.includes('serialize')
  ) {
    return 'Trees';
  }
  if (titleOrUrl.includes('graph') || titleOrUrl.includes('bfs') || titleOrUrl.includes('dfs') || titleOrUrl.includes('dijkstra') || titleOrUrl.includes('topological')) {
    return 'Graphs';
  }
  if (titleOrUrl.includes('dp') || titleOrUrl.includes('dynamic-programming') || titleOrUrl.includes('knapsack') || titleOrUrl.includes('lis') || titleOrUrl.includes('partition-equal')) {
    return 'Dynamic-Programming';
  }
  if (titleOrUrl.includes('string') || titleOrUrl.includes('anagram') || titleOrUrl.includes('palindrome')) {
    return 'Strings';
  }
  if (titleOrUrl.includes('stack') || titleOrUrl.includes('queue') || titleOrUrl.includes('lru-cache') || titleOrUrl.includes('lfu-cache')) {
    return 'Stack-Queue';
  }
  if (titleOrUrl.includes('bit') || titleOrUrl.includes('xor') || titleOrUrl.includes('two-odd') || titleOrUrl.includes('single-number')) {
    return 'Bit-Manipulation';
  }
  if (titleOrUrl.includes('greedy') || titleOrUrl.includes('n-meetings') || titleOrUrl.includes('fractional-knapsack')) {
    return 'Greedy';
  }
  if (titleOrUrl.includes('heap') || titleOrUrl.includes('kth-largest') || titleOrUrl.includes('median') || titleOrUrl.includes('priority-queue')) {
    return 'Heaps';
  }
  if (titleOrUrl.includes('sliding-window') || titleOrUrl.includes('max-consecutive') || titleOrUrl.includes('two-pointer')) {
    return 'Sliding-Window';
  }
  if (titleOrUrl.includes('array') || titleOrUrl.includes('sort') || titleOrUrl.includes('pascal') || titleOrUrl.includes('matrix') || titleOrUrl.includes('two-sum') || titleOrUrl.includes('3sum') || titleOrUrl.includes('4sum')) {
    return 'Arrays';
  }

  return extractTopicFromPathname(pathname) || '';
}

/**
 * Shared topic resolver for all problem categories.
 * Prioritizes sidebar top-level accordion headers for DSA to preserve canonical topic groupings.
 * Query parameters are used first for SQL, Design, and generic categories.
 */
function resolveTopicForCategory(category, pathname, searchParams, data) {
  if (category === 'DSA') {
    const sidebarTopic = extractActiveSidebarTopic();
    const domTopic = canonicalizeTopicLabel(sidebarTopic.mainLabel);
    if (domTopic) return domTopic;

    const paramTopic = (searchParams.get('category') || searchParams.get('topic') || '').trim();
    if (paramTopic) return titleCaseSlug(paramTopic);

    const keywordTopic = dsaKeywordFallback(pathname, searchParams, data);
    if (keywordTopic) return keywordTopic;

    return 'General';
  }

  const paramTopic = (searchParams.get('category') || searchParams.get('topic') || '').trim();
  if (paramTopic) return titleCaseSlug(paramTopic);

  const sidebarTopic = extractActiveSidebarTopic();
  const domTopic = canonicalizeTopicLabel(sidebarTopic.mainLabel);
  if (domTopic) return domTopic;

  return 'General';
}

/**
 * Classifies a takeuforward.org pathname into supported problem types or unsupported lesson/quiz pages.
 */
function classifyPath(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  const root = segments[0] || '';
  const sub = segments[1] || '';

  if (root === 'practice' && sub) {
    return { type: 'PROBLEM', category: categoryNameFromSegment(sub) };
  }
  if (root === 'practice-test') {
    return { type: 'QUIZ' };
  }
  if (root === 'learning') {
    return { type: 'LESSON' };
  }
  if (root === 'prep-hub') {
    return { type: 'HUB' };
  }
  return { type: 'UNSUPPORTED' };
}

function unsupported(type) {
  return {
    type,
    supported: false,
    category: null,
    slug: null,
    mainTopic: null,
    subTopic: null,
    folderPath: null,
    categoryPath: null
  };
}

export function resolveHierarchy(data = {}) {
  const pageUrl = data.url || window.location.href;
  let urlObj;
  try {
    urlObj = new URL(pageUrl);
  } catch (e) {
    urlObj = { pathname: '', searchParams: new URLSearchParams() };
  }

  const pathname = urlObj.pathname.toLowerCase();
  const searchParams = urlObj.searchParams;

  const classified = classifyPath(pathname);
  if (classified.type !== 'PROBLEM') {
    return unsupported(classified.type);
  }

  const category = classified.category;

  // Slug is derived directly from the URL pathname to ensure stable folder naming across detection channels.
  const slug = pathname.split('/').filter(Boolean).pop() || '';

  // -------------------------------------------------------------
  // SQL problems follow a flat hierarchy: SQL/<mainTopic>/<slug> without nested subtopics.
  // -------------------------------------------------------------
  if (category === 'SQL') {
    let mainTopic = resolveTopicForCategory('SQL', pathname, searchParams, data);

    // Fallback keyword classifier for SQL problems when query parameters and DOM lack specific topics.
    if (mainTopic === 'General') {
      if (pathname.includes('data-engineering')) {
        mainTopic = 'Data-Engineering';
      } else if (pathname.includes('join')) {
        mainTopic = 'Joins';
      } else if (pathname.includes('aggregate') || pathname.includes('group')) {
        mainTopic = 'Aggregation';
      } else if (pathname.includes('subquery')) {
        mainTopic = 'Subqueries';
      } else {
        mainTopic = extractTopicFromPathname(pathname, ['sql']) || 'Basics';
      }
    }

    const cleanMain = sanitizePathSegment(mainTopic);

    return {
      type: 'PROBLEM',
      supported: true,
      category: 'SQL',
      slug,
      mainTopic: cleanMain,
      subTopic: 'General',
      folderPath: `SQL/${cleanMain}`,
      categoryPath: `SQL/${cleanMain}`
    };
  }

  // -------------------------------------------------------------
  // DSA, Design, and generic subjects share the canonical <Category>/<mainTopic> folder hierarchy.
  // -------------------------------------------------------------
  const mainTopic = resolveTopicForCategory(category, pathname, searchParams, data);
  const subTopic = canonicalizeTopicLabel(extractActiveSidebarTopic().subLabel) || extractSubTopicFromDOM() || 'General';

  const cleanMain = sanitizePathSegment(mainTopic);
  const cleanSub = sanitizePathSegment(subTopic);

  return {
    type: 'PROBLEM',
    supported: true,
    category,
    slug,
    mainTopic: cleanMain,
    subTopic: cleanSub,
    folderPath: `${category}/${cleanMain}`,
    categoryPath: `${category}/${cleanMain}`
  };
}
