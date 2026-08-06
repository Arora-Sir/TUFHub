/**
 * TUFHub Root README.md Enhanced Builder (Multi-Category Table Index)
 * Author: Mohit Arora (@Arora-Sir)
 */

import { uploadToGitHub } from './uploader.js';
import { decode, normalizeReadmeForCompare } from '../util.js';

/**
 * @returns {Promise<{contentSha,commitSha,htmlUrl}|null>} null when the
 * generated content is identical to what's already on GitHub (after
 * normalizing out the date stamp) - GitHub's Contents API does not skip
 * identical-content PUTs on its own (confirmed against real commit history),
 * so this check is what actually prevents a no-op commit on every call.
 */
export async function updateRootReadme(token, hook, mainTopic, subTopic, problemSlug, stats) {
  const readmePath = 'README.md';
  let sha = '';
  let existingContent = '';

  try {
    const res = await fetch(`https://api.github.com/repos/${hook}/contents/${readmePath}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json'
      }
    });

    if (res.ok) {
      const json = await res.json();
      sha = json.sha;
      existingContent = decode(json.content);
    }
  } catch (e) {
    // Initial creation
  }

  const updatedContent = generateRootReadmeMarkdown(stats);

  if (existingContent && normalizeReadmeForCompare(updatedContent) === normalizeReadmeForCompare(existingContent)) {
    return null;
  }

  return uploadToGitHub(
    token,
    hook,
    readmePath,
    updatedContent,
    `Update ROOT README.md problem index - TUFHub`,
    sha
  );
}

export function generateRootReadmeMarkdown(stats) {
  const solved = stats ? stats.solved || 0 : 0;
  const easy = stats ? stats.easy || 0 : 0;
  const medium = stats ? stats.medium || 0 : 0;
  const hard = stats ? stats.hard || 0 : 0;
  const lastSync = new Date().toISOString().split('T')[0];

  let markdown = `# 🚀 TUF-Solutions

> Auto-synced using [TUFHub](https://github.com/Arora-Sir/TUFHub) - Solutions for [TakeUForward (TUF+)](https://takeuforward.org/plus?affiliate=arorasir)

## 📊 Solution Progress Summary

| Total Solved | 🟢 Easy | 🟡 Medium | 🔴 Hard | Last Synced |
| :---: | :---: | :---: | :---: | :---: |
| **${solved}** | ${easy} | ${medium} | ${hard} | \`${lastSync}\` |

---

## 🗂️ Solved Problems Index

| # | Title | Solution(s) | Difficulty | Category |
| :---: | :--- | :---: | :---: | :--- |
`;

  const problems = stats && stats.problems ? stats.problems : {};
  const slugs = Object.keys(problems).sort();

  if (slugs.length === 0) {
    markdown += `| - | No problems synced yet | - | - | - |\n`;
  } else {
    slugs.forEach((slug, idx) => {
      const p = problems[slug];
      const numStr = (idx + 1).toString().padStart(4, '0');
      const folderUrl = `./${p.folderPath.split('/').map(encodeURIComponent).join('/')}`;
      
      const diffBadge = (p.difficulty || 'Medium').toLowerCase().includes('easy')
        ? '🟢 Easy'
        : (p.difficulty || 'Medium').toLowerCase().includes('hard')
        ? '🔴 Hard'
        : '🟡 Medium';

      let solutionLinks = '';
      const files = p.files || {};
      const fileNames = Object.keys(files).filter(fn => fn && files[fn]);

      if (fileNames.length > 0) {
        // Per-file map (from a sync since the multi-tab feature shipped) - one
        // link per actual file, labeled with the tab's own name so a "Brute" and
        // "Optimal" pair of same-language files don't collapse into one link.
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

      const categoryCell = resolveCategoryAndTopic(p);
      markdown += `| ${numStr} | [${p.title}](${folderUrl}) | ${solutionLinks} | ${diffBadge} | ${categoryCell} |\n`;
    });
  }

  markdown += `\n---\n\n<p align="center">\n  Crafted with ❤️ for Problem Solvers by <a href="https://github.com/Arora-Sir">Mohit Arora</a> &nbsp;|&nbsp; Practice on <a href="https://takeuforward.org/plus?affiliate=arorasir">TakeUForward (TUF+)</a> &nbsp;|&nbsp; ⭐ <a href="https://github.com/Arora-Sir/TUFHub">Star TUFHub on GitHub</a>\n</p>\n`;

  return markdown;
}

function resolveCategoryAndTopic(p) {
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
    if (titleLower.includes('linked') || titleLower.includes('ll')) topicName = 'Linked-List';
    else if (
      titleLower.includes('recursion') || titleLower.includes('combination') ||
      titleLower.includes('subset') || titleLower.includes('permutation') ||
      titleLower.includes('parenthes') || titleLower.includes('phone')
    ) topicName = 'Recursion';
    else if (titleLower.includes('backtrack') || titleLower.includes('n-queen') || titleLower.includes('sudoku')) topicName = 'Backtracking';
    else if (titleLower.includes('search') || titleLower.includes('binary')) topicName = 'Binary-Search';
    else if (titleLower.includes('tree') || titleLower.includes('bst')) topicName = 'Trees';
    else if (titleLower.includes('graph') || titleLower.includes('bfs') || titleLower.includes('dfs')) topicName = 'Graphs';
    else if (titleLower.includes('dp') || titleLower.includes('dynamic') || titleLower.includes('knapsack')) topicName = 'Dynamic-Programming';
    else if (titleLower.includes('string') || titleLower.includes('anagram')) topicName = 'Strings';
    else if (titleLower.includes('stack') || titleLower.includes('queue')) topicName = 'Stack-Queue';
    else if (titleLower.includes('bit') || titleLower.includes('xor')) topicName = 'Bit-Manipulation';
    else if (titleLower.includes('greedy')) topicName = 'Greedy';
    else if (titleLower.includes('heap')) topicName = 'Heaps';
    else if (titleLower.includes('window')) topicName = 'Sliding-Window';
    else if (titleLower.includes('array') || titleLower.includes('matrix')) topicName = 'Arrays';
    else if (titleLower.includes('join') || titleLower.includes('select')) topicName = 'Joins';
    else topicName = 'General';
  }

  return topicName && topicName !== catName && topicName !== 'General'
    ? `\`${catName}\` / \`${topicName}\``
    : `\`${catName}\``;
}
