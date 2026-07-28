/**
 * TUFHub Root README.md Enhanced Builder (LeetHub-2.0 Style Table Index)
 * Author: Mohit Arora (@Arora-Sir)
 */

import { uploadToGitHub } from './uploader.js';
import { decode } from '../util.js';

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

  return uploadToGitHub(
    token,
    hook,
    readmePath,
    updatedContent,
    `Update ROOT README.md problem index - TUFHub`,
    sha
  );
}

function generateRootReadmeMarkdown(stats) {
  const solved = stats ? stats.solved || 0 : 0;
  const easy = stats ? stats.easy || 0 : 0;
  const medium = stats ? stats.medium || 0 : 0;
  const hard = stats ? stats.hard || 0 : 0;
  const lastSync = new Date().toISOString().split('T')[0];

  const header = `# 🚀 TUF-Solutions

> Auto-synced using [TUFHub](https://github.com/Arora-Sir/TUFHub) — TakeUForward (TUF+) Solutions Repository

## 📊 Solution Progress Summary

| Total Solved | 🟢 Easy | 🟡 Medium | 🔴 Hard | Last Synced |
| :---: | :---: | :---: | :---: | :---: |
| **${solved}** | ${easy} | ${medium} | ${hard} | \`${lastSync}\` |

---

## 🗂️ Solved Problems Index

| # | Title | Solution | Difficulty | Category |
| :---: | :--- | :---: | :---: | :--- |
`;

  let rows = '';
  const problems = stats && stats.problems ? stats.problems : {};
  const slugs = Object.keys(problems).sort();

  if (slugs.length === 0) {
    rows += `| - | No problems synced yet | - | - | - |\n`;
  } else {
    slugs.forEach((slug, idx) => {
      const p = problems[slug];
      const numStr = (idx + 1).toString().padStart(4, '0');
      const folderUrl = `./${p.folderPath.split('/').map(encodeURIComponent).join('/')}`;
      const codeUrl = `${folderUrl}/${encodeURIComponent(p.codeFileName)}`;
      
      const diffBadge = p.difficulty.toLowerCase().includes('easy')
        ? '🟢 Easy'
        : p.difficulty.toLowerCase().includes('hard')
        ? '🔴 Hard'
        : '🟡 Medium';

      const ext = p.codeFileName.split('.').pop() || 'code';
      const langLabel = ext.toUpperCase();

      rows += `| ${numStr} | [${p.title}](${folderUrl}) | [${langLabel}](${codeUrl}) | ${diffBadge} | \`${p.mainTopic}\` / \`${p.subTopic}\` |\n`;
    });
  }

  const footer = `\n---\n*Generated with ❤️ by [TUFHub](https://github.com/Arora-Sir/TUFHub)*\n`;

  return header + rows + footer;
}
