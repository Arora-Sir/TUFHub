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

import { sanitizePathSegment, convertToSlug, addLeadingZeros } from '../util.js';

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

  if (subjectParam.includes('linked-list') || pathname.includes('linked-list') || pathname.includes('/ll/')) {
    mainTopic = 'Linked-List';
  } else if (subjectParam.includes('array') || pathname.includes('array') || pathname.includes('sorting')) {
    mainTopic = 'Arrays';
  } else if (subjectParam.includes('binary-search') || pathname.includes('binary-search')) {
    mainTopic = 'Binary-Search';
  } else if (subjectParam.includes('recursion') || pathname.includes('recursion')) {
    mainTopic = 'Recursion';
  } else if (subjectParam.includes('backtracking') || pathname.includes('backtracking')) {
    mainTopic = 'Backtracking';
  } else if (subjectParam.includes('tree') || pathname.includes('tree') || pathname.includes('bst')) {
    mainTopic = 'Trees';
  } else if (subjectParam.includes('graph') || pathname.includes('graph')) {
    mainTopic = 'Graphs';
  } else if (subjectParam.includes('dp') || subjectParam.includes('dynamic-programming') || pathname.includes('dp')) {
    mainTopic = 'Dynamic-Programming';
  } else if (subjectParam.includes('string') || pathname.includes('string')) {
    mainTopic = 'Strings';
  } else if (subjectParam.includes('stack') || subjectParam.includes('queue') || pathname.includes('stack') || pathname.includes('queue')) {
    mainTopic = 'Stack-Queue';
  } else if (subjectParam.includes('bit') || pathname.includes('bit')) {
    mainTopic = 'Bit-Manipulation';
  } else if (subjectParam.includes('greedy') || pathname.includes('greedy')) {
    mainTopic = 'Greedy';
  } else if (subjectParam.includes('heap') || pathname.includes('heap')) {
    mainTopic = 'Heaps';
  } else if (subjectParam.includes('sliding-window') || pathname.includes('sliding-window')) {
    mainTopic = 'Sliding-Window';
  } else {
    mainTopic = 'General';
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
