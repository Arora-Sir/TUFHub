/**
 * TUFHub Root README.md Enhanced Builder (Multi-Category Table Index)
 * Author: Mohit Arora (@Arora-Sir)
 */

import { decode, normalizeReadmeForCompare, classifyDifficulty, hasToken } from '../util.js';
import { ghGet } from './uploader.js';

/**
 * Builds root README file payload.
 * Returns null when generated content matches existing repository content after date normalization.
 * @returns {Promise<{path: string, content: string}|null>}
 */
export async function buildRootReadmeFile(token, hook, stats) {
  const readmePath = 'README.md';
  let existingContent = '';

  try {
    const res = await ghGet(`https://api.github.com/repos/${hook}/contents/${readmePath}`, token);

    if (res.ok) {
      const json = await res.json();
      existingContent = decode(json.content);
    }
  } catch (e) {
    // Initial creation
  }

  const updatedContent = generateRootReadmeMarkdown(stats);

  if (existingContent && normalizeReadmeForCompare(updatedContent) === normalizeReadmeForCompare(existingContent)) {
    return null;
  }

  return { path: readmePath, content: updatedContent };
}

export function generateRootReadmeMarkdown(stats) {
  const solved = stats ? stats.solved || 0 : 0;
  const easy = stats ? stats.easy || 0 : 0;
  const medium = stats ? stats.medium || 0 : 0;
  const hard = stats ? stats.hard || 0 : 0;
  const lastSync = new Date().toISOString().split('T')[0];

  let markdown = `# 🚀 TUF-Solutions

> Auto-synced using [TUFHub](https://github.com/Arora-Sir/TUFHub): Solutions for [TakeUForward (TUF+)](https://takeuforward.org/pricing?affiliate=arorasir)

## 📊 Solution Progress Summary

| Total Solved | 🟢 Easy | 🟡 Medium | 🔴 Hard | Last Synced |
| :---: | :---: | :---: | :---: | :---: |
| **${solved}** | ${easy} | ${medium} | ${hard} | \`${lastSync}\` |

---

## 🗂️ Solved Problems Index
`;

  const problems = stats && stats.problems ? stats.problems : {};
  const slugs = Object.keys(problems).sort();

  if (slugs.length === 0) {
    markdown += `\nNo problems synced yet.\n`;
  } else {
    // Groups problems into dedicated tables per category (DSA, SQL, Design).
    // Section headers represent categories, leaving table cells dedicated to specific topics.
    const byCategory = {};
    slugs.forEach(slug => {
      const p = problems[slug];
      const cat = resolveCategory(p);
      (byCategory[cat] = byCategory[cat] || []).push(p);
    });

    // Fixed category ordering prioritizes primary tracks (DSA, SQL, Design), with remaining subjects sorted alphabetically.
    const PREFERRED_CATEGORY_ORDER = ['DSA', 'SQL', 'Design'];
    const allCategories = Object.keys(byCategory);
    const orderedCategories = [
      ...PREFERRED_CATEGORY_ORDER.filter(c => allCategories.includes(c)),
      ...allCategories.filter(c => !PREFERRED_CATEGORY_ORDER.includes(c)).sort()
    ];

    orderedCategories.forEach(cat => {
      const items = byCategory[cat];
      markdown += `\n### ${cat} (${items.length})\n\n`;
      markdown += `| # | Title | Solution(s) | Difficulty | Topic | Last Synced |\n`;
      markdown += `| :---: | :--- | :---: | :---: | :--- | :---: |\n`;

      items.forEach((p, idx) => {
        const numStr = (idx + 1).toString().padStart(4, '0');
        const folderUrl = `./${p.folderPath.split('/').map(encodeURIComponent).join('/')}`;

        // Difficulty values are normalized to classic Easy, Medium, and Hard buckets for table consistency.
        const diffBucket = classifyDifficulty(p.difficulty);
        const diffBadge = diffBucket === 'easy'
          ? '🟢 Easy'
          : diffBucket === 'hard'
          ? '🔴 Hard'
          : diffBucket === 'medium'
          ? '🟡 Medium'
          : '⚪ Unspecified';

        let solutionLinks = '';
        const files = p.files || {};
        const fileNames = Object.keys(files).filter(fn => fn && files[fn]);

        if (fileNames.length > 0) {
          // Generates distinct solution links labeled by tab name (e.g. Brute, Optimal) to preserve multi-tab strategies.
          solutionLinks = fileNames.map(fileName => {
            const fileUrl = `${folderUrl}/${encodeURIComponent(fileName)}`;
            return `[${files[fileName].label}](${fileUrl})`;
          }).join(' ');
        } else {
          // Fallback for stats predating the `files` map (pre-multi-tab sync data).
          const languages = p.languages || {};
          const langExts = Object.keys(languages).filter(k => languages[k] && languages[k] !== 'undefined');

          if (langExts.length > 0) {
            solutionLinks = langExts.map(ext => {
              const fileName = languages[ext];
              const fileUrl = `${folderUrl}/${encodeURIComponent(fileName)}`;
              return `[${ext.toUpperCase()}](${fileUrl})`;
            }).join(' ');
          } else {
            const safeFile = (p.codeFileName && p.codeFileName !== 'undefined') ? p.codeFileName : 'solution.java';
            const ext = safeFile.split('.').pop() || 'java';
            const fileUrl = `${folderUrl}/${encodeURIComponent(safeFile)}`;
            solutionLinks = `[${ext.toUpperCase()}](${fileUrl})`;
          }
        }

        const topicCell = `\`${resolveTopic(p) || 'General'}\``;
        // Reflects the date when the problem or its metadata was last synced to GitHub.
        const lastSynced = p.updatedAt ? new Date(p.updatedAt).toISOString().split('T')[0] : '-';
        markdown += `| ${numStr} | [${p.title}](${folderUrl}) | ${solutionLinks} | ${diffBadge} | ${topicCell} | \`${lastSynced}\` |\n`;
      });
    });
  }

  markdown += `\n---\n\n<p align="center">\n  Crafted with ❤️ for Problem Solvers by <a href="https://github.com/Arora-Sir">Mohit Arora</a> &nbsp;|&nbsp; Practice on <a href="https://takeuforward.org/pricing?affiliate=arorasir">TakeUForward (TUF+)</a> &nbsp;|&nbsp; ⭐ <a href="https://github.com/Arora-Sir/TUFHub">Star TUFHub on GitHub</a>\n</p>\n`;

  return markdown;
}

function resolveCategory(p) {
  const parts = (p.folderPath || '').split('/').filter(Boolean);
  return parts[0] || 'DSA';
}

function resolveTopic(p) {
  const parts = (p.folderPath || '').split('/').filter(Boolean);
  const catName = parts[0] || 'DSA';
  const slug = parts[parts.length - 1] || '';

  let topicName = '';

  if (parts.length >= 3) {
    const candidate = parts[1];
    const cleanCand = candidate.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cleanCand !== cleanSlug && !cleanSlug.includes(cleanCand) && !cleanCand.includes(cleanSlug)) {
      topicName = candidate;
    }
  } else if (p.mainTopic && p.mainTopic !== catName) {
    const candidate = p.mainTopic.includes('/') ? p.mainTopic.split('/').pop() : p.mainTopic;
    const cleanCand = candidate.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cleanCand !== cleanSlug && !cleanSlug.includes(cleanCand) && !cleanCand.includes(cleanSlug)) {
      topicName = candidate;
    }
  }

  if (!topicName || topicName === catName || topicName === 'General' || (slug && topicName.toLowerCase() === slug.toLowerCase())) {
    const titleLower = ((p.title || '') + ' ' + (p.folderPath || '') + ' ' + (p.mainTopic || '')).toLowerCase();
    // Short keyword abbreviations use hasToken with a left word-boundary to prevent false-positive substring matches.
    // NOTE: Substring matching previously misclassified problems like "sub-BST-rings" as bst and "a-LL-three-characters" as ll.
    if (titleLower.includes('linked') || hasToken(titleLower, 'll')) topicName = 'Linked-List';
    else if (
      titleLower.includes('recursion') || titleLower.includes('combination') ||
      titleLower.includes('subset') || titleLower.includes('permutation') ||
      titleLower.includes('parenthes') || titleLower.includes('phone')
    ) topicName = 'Recursion';
    else if (titleLower.includes('backtrack') || titleLower.includes('n-queen') || titleLower.includes('sudoku')) topicName = 'Backtracking';
    else if (titleLower.includes('search') || titleLower.includes('binary')) topicName = 'Binary-Search';
    else if (titleLower.includes('tree') || hasToken(titleLower, 'bst')) topicName = 'Trees';
    else if (titleLower.includes('graph') || hasToken(titleLower, 'bfs') || hasToken(titleLower, 'dfs')) topicName = 'Graphs';
    else if (hasToken(titleLower, 'dp') || titleLower.includes('dynamic') || titleLower.includes('knapsack')) topicName = 'Dynamic-Programming';
    else if (titleLower.includes('string') || titleLower.includes('anagram')) topicName = 'Strings';
    else if (titleLower.includes('stack') || titleLower.includes('queue')) topicName = 'Stack-Queue';
    else if (hasToken(titleLower, 'bit') || hasToken(titleLower, 'xor')) topicName = 'Bit-Manipulation';
    else if (titleLower.includes('greedy')) topicName = 'Greedy';
    else if (titleLower.includes('heap')) topicName = 'Heaps';
    else if (titleLower.includes('window')) topicName = 'Sliding-Window';
    else if (titleLower.includes('array') || titleLower.includes('matrix')) topicName = 'Arrays';
    else if (titleLower.includes('join') || titleLower.includes('select')) topicName = 'Joins';
    else topicName = 'General';
  }

  return topicName && topicName !== catName ? topicName : 'General';
}
