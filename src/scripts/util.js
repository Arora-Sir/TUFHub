/**
 * TUFHub Utilities & Constants
 * Author: Mohit Arora (@Arora-Sir)
 */

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
  // Remove parentheses, special characters, and normalize spaces
  let cleaned = segment
    .toString()
    .replace(/[()?:*<>"|]/g, '')
    .replace(/\s+/g, '-')
    .trim();
  
  if (cleaned.length === 0 || cleaned.length > 50) return 'General';
  return cleaned;
}

export function encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

export function decode(str) {
  return decodeURIComponent(escape(atob(str)));
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
