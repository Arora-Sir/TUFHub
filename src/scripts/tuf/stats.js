/**
 * TUFHub Stats, SHA State & Offline Queue Persistence
 * Author: Mohit Arora (@Arora-Sir)
 */

import { decode, normalizeReadmeForCompare } from '../util.js';
import { uploadToGitHub } from './uploader.js';
import { generateRootReadmeMarkdown } from './rootReadme.js';

export const DIAG_LIMIT = 50;

/**
 * Detects an orphaned content script. When Chrome updates or reloads the
 * extension underneath an open tab, the isolated world keeps running but every
 * chrome.* call throws "Extension context invalidated". chrome.runtime.id goes
 * undefined at that moment, which is the only reliable synchronous signal.
 * Without this check the failure surfaces as an empty storage read, which the
 * sync engine used to misreport as "GitHub not connected".
 */
export function isExtensionContextAlive() {
  try {
    return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
}

/**
 * Appends one entry to a bounded diagnostic ring buffer in chrome.storage.local.
 * Every decision point that can abort a sync writes here, so a silent drop can
 * be diagnosed from the popup instead of requiring live DevTools.
 */
export async function pushDiag(stage, reasonCode = '', detail = '') {
  if (!isExtensionContextAlive()) return;
  try {
    const data = await safeGetStorage('tufhub_diag');
    const log = Array.isArray(data.tufhub_diag) ? data.tufhub_diag : [];
    log.push({
      ts: Date.now(),
      stage,
      reasonCode,
      detail: typeof detail === 'string' ? detail.slice(0, 300) : String(detail).slice(0, 300),
      url: (typeof location !== 'undefined' && location.href) ? location.href.slice(0, 200) : ''
    });
    while (log.length > DIAG_LIMIT) log.shift();
    await safeSetStorage({ tufhub_diag: log });
  } catch (e) {}
}

export async function getDiag() {
  const data = await safeGetStorage('tufhub_diag');
  return Array.isArray(data.tufhub_diag) ? data.tufhub_diag : [];
}

export async function clearDiag() {
  await safeSetStorage({ tufhub_diag: [] });
}

/**
 * Latest-state snapshot for the popup's Sync Health panel. Kept separate from
 * the ring buffer so the popup can render without scanning the whole log.
 */
export async function updateHealth(patch) {
  if (!isExtensionContextAlive()) return;
  try {
    const data = await safeGetStorage('tufhub_health');
    const health = data.tufhub_health || {};
    await safeSetStorage({ tufhub_health: { ...health, ...patch } });
  } catch (e) {}
}

export async function getHealth() {
  const data = await safeGetStorage('tufhub_health');
  return data.tufhub_health || {};
}

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

  // Keyed by slug+file (matching isDebounced/isCodeIdentical below) so this
  // dual-detection-channel dedup guard doesn't throttle a genuinely different
  // file just because another tab of the same problem synced moments earlier.
  const syncTimeKey = problemMeta.codeFileName ? `${problemSlug}::${problemMeta.codeFileName}` : problemSlug;
  stats.last_sync_time[syncTimeKey] = Date.now();

  if (!stats.hierarchy) stats.hierarchy = {};
  stats.hierarchy[mainTopic] = stats.hierarchy[mainTopic] || {};
  stats.hierarchy[mainTopic][subTopic] = true;

  if (!stats.problems) stats.problems = {};
  
  const existingProb = stats.problems[problemSlug] || {};

  // Legacy field, kept for scanAndSyncRepoStats' repo-reconciliation path and any
  // stats predating the per-file `files` map below - keyed by extension, so it
  // still only ever holds the LAST file of a given language (as before).
  const languages = existingProb.languages || {};
  if (problemMeta.codeFileName) {
    const ext = problemMeta.codeFileName.split('.').pop() || 'code';
    languages[ext] = problemMeta.codeFileName;
  }

  // Keyed by filename, not extension, so two same-language tabs ("Brute.java" +
  // "Optimal.java") both survive instead of the second silently overwriting the
  // first in the root README's Solution(s) column.
  const files = { ...(existingProb.files || {}) };
  if (problemMeta.codeFileName) {
    const ext = problemMeta.codeFileName.split('.').pop() || 'code';
    files[problemMeta.codeFileName] = {
      ext,
      label: problemMeta.fileLabel || ext.toUpperCase()
    };
  }

  stats.problems[problemSlug] = {
    title: problemMeta.title || existingProb.title || problemSlug,
    difficulty: difficulty || existingProb.difficulty || 'Medium',
    mainTopic,
    subTopic,
    codeFileName: problemMeta.codeFileName || existingProb.codeFileName || 'solution.cpp',
    folderPath: problemMeta.folderPath || existingProb.folderPath || `${mainTopic}/${subTopic}/${problemSlug}`,
    languages,
    files,
    updatedAt: Date.now()
  };

  await safeSetStorage({ stats });
  return stats;
}
function generateHashCode(str) {
  let hash = 0;
  for (let i = 0, len = str.length; i < len; i++) {
    const chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return hash.toString(36);
}

// Keyed by slug + filename, not slug alone - once a problem can have multiple
// solution files (per-tab sync), a slug-only key would let syncing Tab-2's code
// corrupt the "did Tab-1 change" check for Tab-1's own file.
function codeHashKey(slug, fileName) {
  return `${slug}::${fileName}`;
}

export async function isCodeIdentical(slug, fileName, newCode) {
  const hash = generateHashCode(newCode || '');
  const storage = await safeGetStorage('tufhub_code_hashes');
  const hashes = storage.tufhub_code_hashes || {};
  return hashes[codeHashKey(slug, fileName)] === hash;
}

export async function updateCodeHash(slug, fileName, newCode) {
  const hash = generateHashCode(newCode || '');
  const storage = await safeGetStorage('tufhub_code_hashes');
  const hashes = storage.tufhub_code_hashes || {};
  hashes[codeHashKey(slug, fileName)] = hash;
  await safeSetStorage({ tufhub_code_hashes: hashes });
}


export async function isDebounced(problemSlug, fileName, cooldownMs = 5000) {
  const stats = await getStats();
  const key = fileName ? `${problemSlug}::${fileName}` : problemSlug;
  const lastTime = stats.last_sync_time ? stats.last_sync_time[key] : null;
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

/**
 * Replaces the queue wholesale. Used by the flush loop to retain items that
 * failed to replay instead of dropping them.
 */
export async function setOfflineQueue(queue) {
  await safeSetStorage({ tufhub_queue: Array.isArray(queue) ? queue : [] });
}

export async function resetStats() {
  const emptyStats = {
    solved: 0,
    easy: 0,
    medium: 0,
    hard: 0,
    shas: {},
    last_sync_time: {},
    hierarchy: {},
    problems: {}
  };
  await safeSetStorage({ stats: emptyStats });
  return emptyStats;
}

export async function scanAndSyncRepoStats(token, hook, force = false) {
  if (!token || !hook) return null;

  const currentStats = await getStats();
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  const lastScan = currentStats.last_repo_scan || 0;

  if (!force && currentStats.solved > 0 && (Date.now() - lastScan < SIX_HOURS_MS)) {
    console.log('[TUFHub Stats] Repo scan skipped (fresh within 6h gate).');
    return currentStats;
  }

  try {
    const existingShas = currentStats.shas || {};
    const existingProblems = currentStats.problems || {};
    const existingHierarchy = currentStats.hierarchy || {};
    const existingLastSyncTime = currentStats.last_sync_time || {};

    const stats = {
      solved: 0,
      easy: 0,
      medium: 0,
      hard: 0,
      shas: { ...existingShas },
      last_sync_time: { ...existingLastSyncTime },
      hierarchy: { ...existingHierarchy },
      problems: { ...existingProblems },
      last_repo_scan: Date.now()
    };

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
        let parsedSolved = 0;
        let parsedEasy = 0;
        let parsedMedium = 0;
        let parsedHard = 0;
        if (summaryMatch) {
          parsedSolved = parseInt(summaryMatch[1], 10) || 0;
          parsedEasy = parseInt(summaryMatch[2], 10) || 0;
          parsedMedium = parseInt(summaryMatch[3], 10) || 0;
          parsedHard = parseInt(summaryMatch[4], 10) || 0;
        }

        let parsedCount = 0;

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

              if (slug && slug !== '-' && title !== 'No problems synced yet') {
                parsedCount++;
                const existing = existingShas[slug];
                stats.shas[slug] = existing ? { ...existing, synced: true } : { synced: true };
                const parts = folderPath.split('/');
                const mainCategory = parts[0] || 'DSA';
                const mainTopic = parts.length > 2 ? parts[1] : (parts[1] && parts[1] !== slug ? parts[1] : 'General');
                const subTopic = parts.length > 3 ? parts[2] : 'General';

                const solCol = cols[2] || '';
                const solMatches = [...solCol.matchAll(/\[(.*?)\]\((.*?)\)/g)];
                const languages = {};
                let primaryCodeFileName = '';

                solMatches.forEach(m => {
                  const label = m[1].toLowerCase();
                  const link = m[2];
                  const fileName = link ? link.split('/').pop() : '';
                  if (fileName && fileName !== 'undefined') {
                    languages[label] = fileName;
                    if (!primaryCodeFileName) primaryCodeFileName = fileName;
                  }
                });

                if (!primaryCodeFileName) {
                  primaryCodeFileName = 'solution.java';
                }
                const ext = primaryCodeFileName.split('.').pop() || 'java';
                if (Object.keys(languages).length === 0) {
                  languages[ext] = primaryCodeFileName;
                }

                stats.problems[slug] = {
                  title,
                  difficulty,
                  mainTopic,
                  subTopic,
                  folderPath,
                  codeFileName: primaryCodeFileName,
                  languages,
                  updatedAt: Date.now()
                };
              }
            }
          }
        });

        // Guard against zero-reset if local stats had solved > 0 but parse found 0 problems
        if (parsedCount === 0 && parsedSolved === 0 && currentStats.solved > 0) {
          stats.solved = currentStats.solved;
          stats.easy = currentStats.easy;
          stats.medium = currentStats.medium;
          stats.hard = currentStats.hard;
        } else {
          stats.solved = parsedSolved || parsedCount;
          stats.easy = parsedEasy;
          stats.medium = parsedMedium;
          stats.hard = parsedHard;
        }

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
          stats.easy = Math.floor(stats.solved * 0.3);
          stats.medium = Math.floor(stats.solved * 0.5);
          stats.hard = stats.solved - stats.easy - stats.medium;

          uniqueFolders.forEach(folder => {
            const parts = folder.split('/');
            const slug = parts[parts.length - 1];
            const existing = existingShas[slug];
            stats.shas[slug] = existing ? { ...existing, synced: true } : { synced: true };
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

// -------------------------------------------------------------
// True repo reconciliation (Sync button) - scans the actual git tree as
// ground truth and rewrites the root README to match, instead of the cheap
// path above which only mirrors whatever the README already says.
// -------------------------------------------------------------
const RECONCILE_COOLDOWN_MS = 60 * 1000;
const RATE_LIMIT_FLOOR = 50;

async function fetchTree(token, hook, branch) {
  return fetch(`https://api.github.com/repos/${hook}/git/trees/${branch}?recursive=1`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json'
    }
  });
}

/**
 * Reconstructs the display label for a file from its own name, matching
 * exactly how deriveFileLabel() names files at sync time - so a name like
 * "Optimal.java" round-trips to label "Optimal", and legacy "solution.java"
 * round-trips to the pre-existing bare-extension label "JAVA".
 */
function labelFromFileName(fileName) {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot + 1) : '';
  if (base.toLowerCase() === 'solution') return ext.toUpperCase() || 'FILE';
  return base;
}

export async function reconcileRepoFromTree(token, hook) {
  if (!token || !hook) return { ok: false, reason: 'error', message: 'Not connected.' };

  const cooldownData = await safeGetStorage('tufhub_last_reconcile_at');
  const lastReconcile = cooldownData.tufhub_last_reconcile_at || 0;
  const sinceLast = Date.now() - lastReconcile;
  if (sinceLast < RECONCILE_COOLDOWN_MS) {
    return { ok: true, reason: 'cooldown', remainingMs: RECONCILE_COOLDOWN_MS - sinceLast };
  }

  let res;
  try {
    res = await fetchTree(token, hook, 'main');
    if (!res.ok) res = await fetchTree(token, hook, 'master');
  } catch (e) {
    return { ok: false, reason: 'error', message: 'Network error reaching GitHub.' };
  }

  const rateRemaining = parseInt(res.headers.get('X-RateLimit-Remaining') || '', 10);
  if (!Number.isNaN(rateRemaining) && rateRemaining < RATE_LIMIT_FLOOR) {
    return { ok: false, reason: 'rate_limited' };
  }

  if (!res.ok) {
    if (res.status === 401) return { ok: false, reason: 'auth', message: 'GitHub token invalid or expired.' };
    if (res.status === 403) return { ok: false, reason: 'rate_limited' };
    if (res.status === 404) return { ok: false, reason: 'not_found', message: 'Repository not found.' };
    return { ok: false, reason: 'error', message: `GitHub returned HTTP ${res.status}.` };
  }

  let treeData;
  try {
    treeData = await res.json();
  } catch (e) {
    return { ok: false, reason: 'error', message: 'Could not parse repository tree.' };
  }

  if (treeData.truncated) {
    return { ok: false, reason: 'truncated' };
  }

  const tree = Array.isArray(treeData.tree) ? treeData.tree : [];

  // Group blobs by parent folder. A folder only counts as a real, currently-
  // existing problem if it contains a README.md blob - every problem folder
  // gets one via buildProblemReadme, which is a far more reliable signal than
  // matching a filename substring (the old fallback's `includes('solution.')`
  // check, which misses the v1.2.0 Solution-N/custom-name naming entirely).
  const folders = new Map(); // folderPath -> { hasReadme, files: [{name, sha}] }
  for (const item of tree) {
    if (item.type !== 'blob') continue;
    const parts = item.path.split('/');
    if (parts.length < 2) continue; // root-level file, e.g. the repo's own README.md - not a problem folder
    const fileName = parts[parts.length - 1];
    const folderPath = parts.slice(0, -1).join('/');

    if (!folders.has(folderPath)) folders.set(folderPath, { hasReadme: false, files: [] });
    const entry = folders.get(folderPath);
    if (fileName === 'README.md') {
      entry.hasReadme = true;
    } else {
      entry.files.push({ name: fileName, sha: item.sha });
    }
  }

  const currentStats = await getStats();
  const existingProblems = currentStats.problems || {};
  const reconciledProblems = {};
  const reconciledShas = {};
  const liveSlugs = new Set();

  for (const [folderPath, entry] of folders) {
    if (!entry.hasReadme || entry.files.length === 0) continue;
    const parts = folderPath.split('/');
    const slug = parts[parts.length - 1];
    liveSlugs.add(slug);

    const files = {};
    const shas = {};
    entry.files.forEach(f => {
      const ext = f.name.includes('.') ? f.name.split('.').pop() : 'code';
      files[f.name] = { ext, label: labelFromFileName(f.name) };
      shas[f.name] = f.sha;
    });

    const cached = existingProblems[slug];
    if (cached) {
      // Known to this browser - trust its title/difficulty/mainTopic/subTopic
      // (richer than anything derivable from the tree), refresh only the
      // file listing to match what's actually there now.
      reconciledProblems[slug] = {
        ...cached,
        folderPath,
        files,
        updatedAt: Date.now()
      };
    } else {
      // Unknown to this browser (different profile, cleared storage).
      // Placeholder metadata only - deliberately not fetching this folder's
      // own README for exact title/difficulty, which would cost one extra
      // API call per unknown folder and scale badly for a large gap.
      reconciledProblems[slug] = {
        title: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        difficulty: 'Medium',
        folderPath,
        codeFileName: entry.files[0].name,
        languages: {},
        files,
        updatedAt: Date.now()
      };
    }
    reconciledShas[slug] = shas;
  }

  const solvedSlugs = Object.keys(reconciledProblems);
  const counts = { solved: solvedSlugs.length, easy: 0, medium: 0, hard: 0 };
  solvedSlugs.forEach(slug => {
    const d = (reconciledProblems[slug].difficulty || 'medium').toLowerCase();
    if (d.includes('easy')) counts.easy++;
    else if (d.includes('hard')) counts.hard++;
    else counts.medium++;
  });

  const hierarchy = {};
  solvedSlugs.forEach(slug => {
    const p = reconciledProblems[slug];
    if (p.mainTopic) {
      hierarchy[p.mainTopic] = hierarchy[p.mainTopic] || {};
      hierarchy[p.mainTopic][p.subTopic || 'General'] = true;
    }
  });

  // Purge dedup/debounce state for dropped slugs so a since-deleted-then-
  // resubmitted problem can't be mistaken for an unchanged duplicate. Both
  // maps are keyed `slug::fileName` (v1.2.0), so split on the separator
  // rather than doing a plain key lookup.
  const removedSlugs = Object.keys(existingProblems).filter(slug => !liveSlugs.has(slug));
  const hashData = await safeGetStorage('tufhub_code_hashes');
  const codeHashes = hashData.tufhub_code_hashes || {};
  const purgedHashes = {};
  Object.keys(codeHashes).forEach(key => {
    const slug = key.split('::')[0];
    if (liveSlugs.has(slug) || !removedSlugs.includes(slug)) purgedHashes[key] = codeHashes[key];
  });

  const purgedLastSyncTime = {};
  Object.keys(currentStats.last_sync_time || {}).forEach(key => {
    const slug = key.split('::')[0];
    if (liveSlugs.has(slug) || !removedSlugs.includes(slug)) purgedLastSyncTime[key] = currentStats.last_sync_time[key];
  });

  const reconciledStats = {
    ...currentStats,
    ...counts,
    shas: reconciledShas,
    problems: reconciledProblems,
    hierarchy,
    last_sync_time: purgedLastSyncTime,
    last_repo_scan: Date.now()
  };

  const generatedContent = generateRootReadmeMarkdown(reconciledStats);

  let existingContent = '';
  let readmeSha = '';
  try {
    const readmeRes = await fetch(`https://api.github.com/repos/${hook}/contents/README.md`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json'
      }
    });
    if (readmeRes.ok) {
      const json = await readmeRes.json();
      existingContent = decode(json.content);
      readmeSha = json.sha;
    }
  } catch (e) {
    return { ok: false, reason: 'error', message: 'Could not read current README.' };
  }

  const unchanged = existingContent &&
    normalizeReadmeForCompare(generatedContent) === normalizeReadmeForCompare(existingContent);

  if (unchanged) {
    await safeSetStorage({ stats: reconciledStats, tufhub_code_hashes: purgedHashes });
    await safeSetStorage({ tufhub_last_reconcile_at: Date.now() });
    return { ok: true, reason: 'unchanged', stats: reconciledStats };
  }

  let uploadResult;
  try {
    uploadResult = await uploadToGitHub(
      token,
      hook,
      'README.md',
      generatedContent,
      'Update ROOT README.md problem index - TUFHub (manual sync)',
      readmeSha
    );
  } catch (e) {
    // Repo left untouched on a failed write - local stats intentionally NOT
    // persisted here, so a retry starts from the same known-good state.
    return { ok: false, reason: 'error', message: e && e.message };
  }

  // Persisted only after the write succeeds: if the worker is killed between
  // the two, the repo (ground truth) is correct and local stats are merely
  // stale, which the next reconcile fixes. The reverse order could leave
  // local state claiming a sync that never actually reached GitHub.
  await safeSetStorage({ stats: reconciledStats, tufhub_code_hashes: purgedHashes });
  await safeSetStorage({ tufhub_last_reconcile_at: Date.now() });

  return {
    ok: true,
    reason: 'synced',
    stats: reconciledStats,
    removedSlugs,
    commitSha: uploadResult ? uploadResult.commitSha : '',
    commitUrl: uploadResult ? uploadResult.htmlUrl : ''
  };
}
