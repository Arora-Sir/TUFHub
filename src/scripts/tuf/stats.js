/**
 * TUFHub Stats, SHA State & Offline Queue Persistence
 * Author: Mohit Arora (@Arora-Sir)
 */

import { decode } from '../util.js';

export async function safeGetStorage(keys) {
  try {
    if (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local) {
      const res = await chrome.storage.local.get(keys);
      if (res) return res;
    }
  } catch (e) {
    console.warn('[TUFHub Debug] Direct storage access failed. Using background messenger.');
  }

  return new Promise((resolve) => {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'GET_STORAGE', keys }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({});
          } else {
            resolve(res || {});
          }
        });
      } else {
        resolve({});
      }
    } catch (e) {
      resolve({});
    }
  });
}

export async function safeSetStorage(data) {
  try {
    if (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set(data);
      return;
    }
  } catch (e) {
    console.warn('[TUFHub Debug] Direct storage write failed. Using background messenger.');
  }

  return new Promise((resolve) => {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'SET_STORAGE', data }, (res) => {
          resolve(res || {});
        });
      } else {
        resolve({});
      }
    } catch (e) {
      resolve({});
    }
  });
}

export async function getStats() {
  const data = await safeGetStorage('stats');
  let stats = data.stats;
  if (!stats) {
    stats = {
      solved: 0,
      easy: 0,
      medium: 0,
      hard: 0,
      shas: {},
      last_sync_time: {},
      hierarchy: {},
      problems: {}
    };
  }
  if (!stats.hierarchy) stats.hierarchy = {};
  if (!stats.problems) stats.problems = {};
  return stats;
}

export async function updateStats(difficulty, problemSlug, fileShas, mainTopic = 'DSA', subTopic = 'General', problemMeta = {}) {
  const stats = await getStats();
  
  if (!stats.shas[problemSlug]) {
    stats.solved += 1;
    const diffLower = (difficulty || 'medium').toLowerCase();
    if (diffLower.includes('easy')) stats.easy += 1;
    else if (diffLower.includes('hard')) stats.hard += 1;
    else stats.medium += 1;
  }

  stats.shas[problemSlug] = {
    ...(stats.shas[problemSlug] || {}),
    ...fileShas
  };

  stats.last_sync_time[problemSlug] = Date.now();

  if (!stats.hierarchy) stats.hierarchy = {};
  stats.hierarchy[mainTopic] = stats.hierarchy[mainTopic] || {};
  stats.hierarchy[mainTopic][subTopic] = true;

  if (!stats.problems) stats.problems = {};
  
  const existingProb = stats.problems[problemSlug] || {};
  const languages = existingProb.languages || {};
  if (problemMeta.codeFileName) {
    const ext = problemMeta.codeFileName.split('.').pop() || 'code';
    languages[ext] = problemMeta.codeFileName;
  }

  stats.problems[problemSlug] = {
    title: problemMeta.title || existingProb.title || problemSlug,
    difficulty: difficulty || existingProb.difficulty || 'Medium',
    mainTopic,
    subTopic,
    codeFileName: problemMeta.codeFileName || existingProb.codeFileName || 'solution.cpp',
    folderPath: problemMeta.folderPath || existingProb.folderPath || `${mainTopic}/${subTopic}/${problemSlug}`,
    languages,
    updatedAt: Date.now()
  };

  await safeSetStorage({ stats });
  return stats;
}

export async function isDebounced(problemSlug, cooldownMs = 5000) {
  const stats = await getStats();
  const lastTime = stats.last_sync_time ? stats.last_sync_time[problemSlug] : null;
  if (lastTime && (Date.now() - lastTime < cooldownMs)) {
    return true;
  }
  return false;
}

// -------------------------------------------------------------
// Offline Queue Management
// -------------------------------------------------------------
export async function enqueueOfflineSync(syncData) {
  const data = await safeGetStorage('tufhub_queue');
  const queue = data.tufhub_queue || [];
  queue.push({
    id: `queue_${Date.now()}`,
    syncData,
    timestamp: Date.now()
  });
  await safeSetStorage({ tufhub_queue: queue });
  console.log('[TUFHub Debug] Enqueued failed sync to offline queue:', syncData.title);
}

export async function getOfflineQueue() {
  const data = await safeGetStorage('tufhub_queue');
  return data.tufhub_queue || [];
}

export async function clearOfflineQueue() {
  await safeSetStorage({ tufhub_queue: [] });
}

export async function scanAndSyncRepoStats(token, hook) {
  if (!token || !hook) return null;

  try {
    const stats = await getStats();

    // 1. Fetch root README.md from repo
    const res = await fetch(`https://api.github.com/repos/${hook}/contents/README.md`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json'
      }
    });

    if (res.ok) {
      const json = await res.json();
      if (json && json.content) {
        const content = decode(json.content);

        // Extract Summary Numbers: | **X** | Y | Z | W |
        const summaryMatch = content.match(/\|\s*\*\*(\d+)\*\*\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/);
        if (summaryMatch) {
          stats.solved = parseInt(summaryMatch[1], 10) || 0;
          stats.easy = parseInt(summaryMatch[2], 10) || 0;
          stats.medium = parseInt(summaryMatch[3], 10) || 0;
          stats.hard = parseInt(summaryMatch[4], 10) || 0;
        }

        // Parse Solved Problems Index rows: | # | Title | Solution(s) | Difficulty | Category |
        const tableLines = content.split('\n');
        tableLines.forEach(line => {
          if (line.startsWith('|') && !line.includes('Total Solved') && !line.includes('Title') && !line.includes(':---')) {
            const cols = line.split('|').map(c => c.trim()).filter(Boolean);
            if (cols.length >= 4) {
              const titleMatch = cols[1]?.match(/\[(.*?)\]\((.*?)\)/);
              const title = titleMatch ? titleMatch[1] : cols[1];
              const folderPath = titleMatch ? titleMatch[2].replace('./', '') : '';
              const slug = folderPath ? folderPath.split('/').pop() : '';

              const diffText = cols[3] || 'Medium';
              let difficulty = 'Medium';
              if (diffText.toLowerCase().includes('easy')) difficulty = 'Easy';
              else if (diffText.toLowerCase().includes('hard')) difficulty = 'Hard';

              if (slug) {
                stats.shas[slug] = stats.shas[slug] || { synced: true };
                const parts = folderPath.split('/');
                const mainCategory = parts[0] || 'DSA';
                const mainTopic = parts.length > 2 ? parts[1] : (parts[1] && parts[1] !== slug ? parts[1] : 'General');
                const subTopic = parts.length > 3 ? parts[2] : 'General';

                stats.problems[slug] = {
                  title,
                  difficulty,
                  mainTopic,
                  subTopic,
                  folderPath,
                  updatedAt: Date.now()
                };
              }
            }
          }
        });

        await safeSetStorage({ stats });
        return stats;
      }
    }

    // 2. Fallback: Scan Git Tree if README.md summary not present
    const treeUrl = `https://api.github.com/repos/${hook}/git/trees/main?recursive=1`;
    let treeRes = await fetch(treeUrl, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json'
      }
    });

    if (!treeRes.ok) {
      treeRes = await fetch(`https://api.github.com/repos/${hook}/git/trees/master?recursive=1`, {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json'
        }
      });
    }

    if (treeRes.ok) {
      const treeData = await treeRes.json();
      if (treeData && Array.isArray(treeData.tree)) {
        const uniqueFolders = new Set();
        treeData.tree.forEach(item => {
          if (item.type === 'blob' && (item.path.endsWith('README.md') || item.path.includes('solution.'))) {
            const parts = item.path.split('/');
            if (parts.length >= 3) {
              parts.pop();
              uniqueFolders.add(parts.join('/'));
            }
          }
        });

        if (uniqueFolders.size > 0) {
          stats.solved = uniqueFolders.size;
          stats.easy = stats.easy || Math.floor(stats.solved * 0.3);
          stats.medium = stats.medium || Math.floor(stats.solved * 0.5);
          stats.hard = stats.hard || (stats.solved - stats.easy - stats.medium);

          uniqueFolders.forEach(folder => {
            const parts = folder.split('/');
            const slug = parts[parts.length - 1];
            stats.shas[slug] = stats.shas[slug] || { synced: true };
            stats.problems[slug] = stats.problems[slug] || {
              title: slug.replace(/-/g, ' ').toUpperCase(),
              difficulty: 'Medium',
              folderPath: folder,
              updatedAt: Date.now()
            };
          });
        }

        await safeSetStorage({ stats });
        return stats;
      }
    }
  } catch (err) {
    console.error('[TUFHub Stats] Error scanning repo stats:', err);
  }

  return await getStats();
}
