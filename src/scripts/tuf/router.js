/**
 * TUFHub Multi-Category Router
 * Author: Mohit Arora (@Arora-Sir)
 * 
 * Dynamically resolves target repository path and hierarchy for code submissions across:
 * - DSA (Data Structures & Algorithms)
 * - SQL (SQL & Data Engineering)
 * - Aptitude (Quantitative & Logical Coding)
 * - Mock Tests (Mock Exam Coding Submissions)
 */

import { sanitizePathSegment } from '../util.js';

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
  const subjectParam = (searchParams.get('subject') || '').toLowerCase();
  const approachParam = (searchParams.get('approach') || '').toLowerCase();
  const rawLanguage = (data.language || '').toLowerCase();

  let category = 'DSA';
  let mainTopic = 'General';
  let subTopic = 'General';

  // -------------------------------------------------------------
  // 1. SQL Category Detection
  // -------------------------------------------------------------
  if (
    pathname.includes('/plus/sql') ||
    pathname.includes('sql-data-engineering') ||
    subjectParam.includes('sql') ||
    rawLanguage.includes('sql')
  ) {
    category = 'SQL';

    if (pathname.includes('data-engineering') || subjectParam.includes('data-engineering')) {
      mainTopic = 'Data-Engineering';
    } else if (pathname.includes('join') || subjectParam.includes('join')) {
      mainTopic = 'Joins';
    } else if (pathname.includes('aggregate') || pathname.includes('group') || subjectParam.includes('aggregate')) {
      mainTopic = 'Aggregation';
    } else if (pathname.includes('subquery') || subjectParam.includes('subquery')) {
      mainTopic = 'Subqueries';
    } else if (pathname.includes('basic') || subjectParam.includes('basic')) {
      mainTopic = 'Basics';
    } else {
      mainTopic = extractTopicFromPathname(pathname, ['sql']) || 'Basics';
    }

    subTopic = extractSubTopicFromDOM() || 'General';
    const cleanMain = sanitizePathSegment(mainTopic);
    const cleanSub = sanitizePathSegment(subTopic);
    
    return {
      category: 'SQL',
      folderPath: cleanSub !== 'General' ? `SQL/${cleanMain}/${cleanSub}` : `SQL/${cleanMain}`,
      categoryPath: `SQL/${cleanMain}`
    };
  }

  // -------------------------------------------------------------
  // 2. Aptitude Category Detection
  // -------------------------------------------------------------
  if (pathname.includes('/plus/aptitude') || subjectParam.includes('aptitude')) {
    category = 'Aptitude';

    if (pathname.includes('quantitative') || subjectParam.includes('quantitative')) {
      mainTopic = 'Quantitative';
    } else if (pathname.includes('logical') || subjectParam.includes('logical')) {
      mainTopic = 'Logical';
    } else {
      mainTopic = 'Quantitative';
    }

    subTopic = extractTopicFromPathname(pathname, ['aptitude', 'quantitative-aptitude', 'logical-reasoning']) || 'General';
    const cleanMain = sanitizePathSegment(mainTopic);
    const cleanSub = sanitizePathSegment(subTopic);

    return {
      category: 'Aptitude',
      folderPath: cleanSub !== 'General' ? `Aptitude/${cleanMain}/${cleanSub}` : `Aptitude/${cleanMain}`,
      categoryPath: `Aptitude/${cleanMain}`
    };
  }

  // -------------------------------------------------------------
  // 3. Mock Tests Category Detection
  // -------------------------------------------------------------
  if (pathname.includes('/plus/mock-test') || subjectParam.includes('mock-test')) {
    category = 'Mock-Tests';
    const testSlug = extractTopicFromPathname(pathname, ['mock-test']) || 'Practice-Test';
    const cleanTest = sanitizePathSegment(testSlug);

    return {
      category: 'Mock-Tests',
      folderPath: `Mock-Tests/${cleanTest}`,
      categoryPath: `Mock-Tests/${cleanTest}`
    };
  }

  // -------------------------------------------------------------
  // 4. DSA Category Detection (Default)
  // -------------------------------------------------------------
  category = 'DSA';

  const titleOrUrl = (pathname + ' ' + (data.title || '') + ' ' + subjectParam + ' ' + approachParam).toLowerCase();

  if (titleOrUrl.includes('linked-list') || titleOrUrl.includes('ll') || titleOrUrl.includes('reverse-a-list')) {
    mainTopic = 'Linked-List';
  } else if (titleOrUrl.includes('binary-search') || titleOrUrl.includes('search-in-sorted')) {
    mainTopic = 'Binary-Search';
  } else if (titleOrUrl.includes('subsets') || titleOrUrl.includes('recursion') || titleOrUrl.includes('combination-sum') || titleOrUrl.includes('recursive')) {
    mainTopic = 'Recursion';
  } else if (titleOrUrl.includes('backtracking') || titleOrUrl.includes('n-queens') || titleOrUrl.includes('sudoku')) {
    mainTopic = 'Backtracking';
  } else if (titleOrUrl.includes('tree') || titleOrUrl.includes('bst') || titleOrUrl.includes('inorder') || titleOrUrl.includes('preorder')) {
    mainTopic = 'Trees';
  } else if (titleOrUrl.includes('graph') || titleOrUrl.includes('bfs') || titleOrUrl.includes('dfs') || titleOrUrl.includes('dijkstra')) {
    mainTopic = 'Graphs';
  } else if (titleOrUrl.includes('dp') || titleOrUrl.includes('dynamic-programming') || titleOrUrl.includes('knapsack') || titleOrUrl.includes('lis')) {
    mainTopic = 'Dynamic-Programming';
  } else if (titleOrUrl.includes('string') || titleOrUrl.includes('anagram') || titleOrUrl.includes('palindrome')) {
    mainTopic = 'Strings';
  } else if (titleOrUrl.includes('stack') || titleOrUrl.includes('queue') || titleOrUrl.includes('lru-cache')) {
    mainTopic = 'Stack-Queue';
  } else if (titleOrUrl.includes('bit') || titleOrUrl.includes('xor') || titleOrUrl.includes('two-odd')) {
    mainTopic = 'Bit-Manipulation';
  } else if (titleOrUrl.includes('greedy') || titleOrUrl.includes('n-meetings')) {
    mainTopic = 'Greedy';
  } else if (titleOrUrl.includes('heap') || titleOrUrl.includes('kth-largest') || titleOrUrl.includes('median')) {
    mainTopic = 'Heaps';
  } else if (titleOrUrl.includes('sliding-window') || titleOrUrl.includes('max-consecutive')) {
    mainTopic = 'Sliding-Window';
  } else if (titleOrUrl.includes('array') || titleOrUrl.includes('sort') || titleOrUrl.includes('pascal') || titleOrUrl.includes('matrix')) {
    mainTopic = 'Arrays';
  } else {
    mainTopic = extractTopicFromPathname(pathname) || 'General';
  }

  subTopic = extractSubTopicFromDOM() || 'General';

  const cleanMain = sanitizePathSegment(mainTopic);
  const cleanSub = sanitizePathSegment(subTopic);

  return {
    category: 'DSA',
    folderPath: cleanSub !== 'General' ? `DSA/${cleanMain}/${cleanSub}` : `DSA/${cleanMain}`,
    categoryPath: `DSA/${cleanMain}`
  };
}

function extractTopicFromPathname(pathname, ignoreKeywords = []) {
  try {
    const parts = pathname.split('/').filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i].toLowerCase();
      if (p === 'problems' || p === 'plus' || p === 'dsa' || ignoreKeywords.includes(p)) continue;
      
      const formatted = parts[i]
        .split('-')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join('-');
      return formatted;
    }
  } catch (e) {}
  return '';
}

function extractSubTopicFromDOM() {
  try {
    const bodyText = document.body.innerText || '';
    if (bodyText.includes('FAQs (Medium)') || bodyText.includes('FAQs Medium')) return 'FAQs-Medium';
    if (bodyText.includes('FAQs (Hard)') || bodyText.includes('FAQs Hard')) return 'FAQs-Hard';
    if (bodyText.includes('Fundamentals (Single LL)') || bodyText.includes('Fundamentals Single LL')) return 'Fundamentals-Single-LL';
    if (bodyText.includes('Fundamentals (Doubly LL)') || bodyText.includes('Fundamentals Doubly LL')) return 'Fundamentals-Doubly-LL';
    if (bodyText.includes('Logic Building')) return 'Logic-Building';
    if (bodyText.includes('Basic') || bodyText.includes('Basics')) return 'Basics';
  } catch (e) {}
  return '';
}
