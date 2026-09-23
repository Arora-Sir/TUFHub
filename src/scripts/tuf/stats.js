/**
 * TUFHub Stats, SHA State & Code-Hash Persistence
 * Author: Mohit Arora (@Arora-Sir)
 */

import { decode, normalizeReadmeForCompare, classifyDifficulty } from '../util.js';
import { ghGet, uploadToGitHub } from './uploader.js';
import { generateRootReadmeMarkdown } from './rootReadme.js';

export const DIAG_LIMIT = 50;

/**
 * Detects an orphaned content script when extension context invalidates (reload or update under open tab).
 * Checks chrome.runtime.id to distinguish an invalidated context from a genuine empty storage response.
 */
export function isExtensionContextAlive() {
  try {
    return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
}

/**
 * Appends an entry to a bounded diagnostic ring buffer in chrome.storage.local for popup inspection.
 * The background worker passes the submission's own url, since its location is the extension script rather than a TUF page.
 */
export async function pushDiag(stage, reasonCode = '', detail = '', url = '') {
  if (!isExtensionContextAlive()) return;
  try {
    const data = await safeGetStorage('tufhub_diag');
    const log = Array.isArray(data.tufhub_diag) ? data.tufhub_diag : [];
    const pageUrl = url || ((typeof location !== 'undefined' && location.href) ? location.href : '');
    log.push({
      ts: Date.now(),
      stage,
      reasonCode,
      detail: typeof detail === 'string' ? detail.slice(0, 300) : String(detail).slice(0, 300),
      url: pageUrl.slice(0, 200)
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
 * Updates latest-state snapshot for the popup Sync Health panel without scanning the full diagnostic log.
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

/**
 * Pure computation of stats after a proposed sync without writing to storage.
 * Allows previewing root README markdown before committing, persisting only after GitHub confirms success.
 */
export function computeUpdatedStats(currentStats, difficulty, problemSlug, fileShas, mainTopic = 'DSA', subTopic = 'General', problemMeta = {}) {
  const stats = {
    ...currentStats,
    shas: { ...(currentStats.shas || {}) },
    last_sync_time: { ...(currentStats.last_sync_time || {}) },
    hierarchy: { ...(currentStats.hierarchy || {}) },
    problems: { ...(currentStats.problems || {}) }
  };

  if (!stats.shas[problemSlug]) {
    stats.solved = (stats.solved || 0) + 1;
    // Folds 'unspecified' into medium bucket for aggregate tallies, while preserving the raw difficulty label in problem metadata.
    const bucket = classifyDifficulty(difficulty);
    if (bucket === 'easy') stats.easy = (stats.easy || 0) + 1;
    else if (bucket === 'hard') stats.hard = (stats.hard || 0) + 1;
    else stats.medium = (stats.medium || 0) + 1;
  }

  stats.shas[problemSlug] = {
    ...(stats.shas[problemSlug] || {}),
    ...fileShas
  };

  // Keyed by slug+fileName so submitting different solution tabs does not throttle each other.
  const syncTimeKey = problemMeta.codeFileName ? `${problemSlug}::${problemMeta.codeFileName}` : problemSlug;
  stats.last_sync_time[syncTimeKey] = Date.now();

  stats.hierarchy[mainTopic] = { ...(stats.hierarchy[mainTopic] || {}) };
  stats.hierarchy[mainTopic][subTopic] = true;

  const existingProb = stats.problems[problemSlug] || {};

  // Legacy field keyed by extension, retained for backwards compatibility with older stats caches.
  const languages = { ...(existingProb.languages || {}) };
  if (problemMeta.codeFileName) {
    const ext = problemMeta.codeFileName.split('.').pop() || 'code';
    languages[ext] = problemMeta.codeFileName;
  }

  // Keyed by filename so multiple tabs in the same language (e.g. Brute.java, Optimal.java) both survive in the README table.
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
    difficulty: difficulty || existingProb.difficulty || 'Unspecified',
    mainTopic,
    subTopic,
    codeFileName: problemMeta.codeFileName || existingProb.codeFileName || 'solution.cpp',
    folderPath: problemMeta.folderPath || existingProb.folderPath || `${mainTopic}/${subTopic}/${problemSlug}`,
    languages,
    files,
    updatedAt: Date.now()
  };

  return stats;
}

export async function updateStats(difficulty, problemSlug, fileShas, mainTopic = 'DSA', subTopic = 'General', problemMeta = {}) {
  const stats = await getStats();
  const updated = computeUpdatedStats(stats, difficulty, problemSlug, fileShas, mainTopic, subTopic, problemMeta);
  await safeSetStorage({ stats: updated });
  return updated;
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

// Keyed by the full repo path of the file, so each solution tab keeps its own change-detection hash.
// NOTE: Path keys (not slug keys) mean a copy committed to the wrong folder can never make the same code look "already synced" for the right folder.
function codeHashKey(folderPath, fileName) {
  return `${folderPath}/${fileName}`;
}

export async function isCodeIdentical(folderPath, fileName, newCode) {
  const hash = generateHashCode(newCode || '');
  const storage = await safeGetStorage('tufhub_code_hashes');
  const hashes = storage.tufhub_code_hashes || {};
  return hashes[codeHashKey(folderPath, fileName)] === hash;
}

export async function updateCodeHash(folderPath, fileName, newCode) {
  const hash = generateHashCode(newCode || '');
  const storage = await safeGetStorage('tufhub_code_hashes');
  const hashes = storage.tufhub_code_hashes || {};
  hashes[codeHashKey(folderPath, fileName)] = hash;
  await safeSetStorage({ tufhub_code_hashes: hashes });
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
    const res = await ghGet(`https://api.github.com/repos/${hook}/contents/README.md`, token);

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

              const diffText = cols[3] || 'Unspecified';
              let difficulty = 'Unspecified';
              if (diffText.toLowerCase().includes('easy')) difficulty = 'Easy';
              else if (diffText.toLowerCase().includes('hard')) difficulty = 'Hard';
              else if (diffText.toLowerCase().includes('medium')) difficulty = 'Medium';

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
                // Rebuilt from each file's own name (as reconcile does), since the README generator renders `files` labels verbatim and without this map falls back to uppercased extension labels ("Brute" turning into "BRUTE").
                const files = {};
                let primaryCodeFileName = '';

                solMatches.forEach(m => {
                  const label = m[1].toLowerCase();
                  const link = m[2];
                  let fileName = link ? link.split('/').pop() : '';
                  try { fileName = decodeURIComponent(fileName); } catch (e) {}
                  if (fileName && fileName !== 'undefined') {
                    languages[label] = fileName;
                    files[fileName] = { ext: fileName.includes('.') ? fileName.split('.').pop() : 'code', label: labelFromFileName(fileName) };
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

                // Preserve prior updatedAt timestamp from local cache so metadata scans do not falsely mark all problems as synced today.
                // Renders as null (hyphen) when unknown, which accurately indicates historical status.
                const priorUpdatedAt = stats.problems[slug] ? stats.problems[slug].updatedAt : null;
                stats.problems[slug] = {
                  title,
                  difficulty,
                  mainTopic,
                  subTopic,
                  folderPath,
                  codeFileName: primaryCodeFileName,
                  languages,
                  files,
                  updatedAt: priorUpdatedAt || null
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
    let treeRes = await fetchTree(token, hook, 'main');
    if (!treeRes.ok) treeRes = await fetchTree(token, hook, 'master');

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
// True repo reconciliation (Sync button): scans the actual git tree and rewrites the root README to match.
// -------------------------------------------------------------
const RECONCILE_COOLDOWN_MS = 60 * 1000;
const RATE_LIMIT_FLOOR = 50;

function fetchTree(token, hook, branch) {
  return ghGet(`https://api.github.com/repos/${hook}/git/trees/${branch}?recursive=1`, token);
}

/**
 * Fetches last-commit date for a repository path (directory or file).
 * Solutions and README files are committed together in one atomic commit, so any path under a folder gives an accurate last-touched date.
 * Backfills authentic updatedAt timestamps from GitHub commit history during reconciliation.
 * Non-fatal on failure: callers fall back gracefully without breaking repository reconciliation.
 */
async function fetchLastCommitDate(token, hook, path) {
  try {
    const res = await ghGet(`https://api.github.com/repos/${hook}/commits?path=${encodeURIComponent(path)}&per_page=1`, token);
    if (!res.ok) return null;
    const json = await res.json();
    const commit = json[0] && json[0].commit;
    const dateStr = commit && (commit.committer && commit.committer.date || commit.author && commit.author.date);
    return dateStr ? new Date(dateStr).getTime() : null;
  } catch (e) {
    return null;
  }
}

/**
 * Reconstructs the display label for a file from its filename, matching deriveFileLabel() naming logic.
 * Multi-tab files (e.g. "Optimal.java") round-trip to their tab label ("Optimal").
 * Legacy single-tab files ("solution.java") round-trip to their uppercase extension ("JAVA").
 */
function labelFromFileName(fileName) {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot + 1) : '';
  if (base.toLowerCase() === 'solution') return ext.toUpperCase() || 'FILE';
  return base;
}

export async function reconcileRepoFromTree(token, hook, { skipCooldown = false } = {}) {
  if (!token || !hook) return { ok: false, reason: 'error', message: 'Not connected.' };

  if (!skipCooldown) {
    const cooldownData = await safeGetStorage('tufhub_last_reconcile_at');
    const lastReconcile = cooldownData.tufhub_last_reconcile_at || 0;
    const sinceLast = Date.now() - lastReconcile;
    if (sinceLast < RECONCILE_COOLDOWN_MS) {
      return { ok: true, reason: 'cooldown', remainingMs: RECONCILE_COOLDOWN_MS - sinceLast };
    }
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

  // Group blobs by parent folder to identify valid problem directories.
  // NOTE: A folder counts as a problem only when it contains a README.md blob created by buildProblemReadme.
  // NOTE: Checking for README.md is far more reliable than matching solution file prefixes, which misses custom tab names and multi-solution files.
  const folders = new Map(); // folderPath -> { hasReadme, files: [{name, sha}] }
  for (const item of tree) {
    if (item.type !== 'blob') continue;
    const parts = item.path.split('/');
    if (parts.length < 2) continue; // Skip root-level files (such as root README.md).
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
  const slugToFolders = new Map(); // slug -> [folderPath, ...]: tracks multiple folders per slug to surface duplicate folder warnings.

  // Backfill updatedAt timestamps from GitHub commit history rather than trusting local storage cache.
  // Self-heals local storage timestamps against previous reconcile stomping bugs.
  await Promise.all(Array.from(folders.entries()).map(async ([folderPath, entry]) => {
    if (!entry.hasReadme || entry.files.length === 0) return;
    const parts = folderPath.split('/');
    const slug = parts[parts.length - 1];
    liveSlugs.add(slug);
    if (!slugToFolders.has(slug)) slugToFolders.set(slug, []);
    slugToFolders.get(slug).push(folderPath);

    const files = {};
    const shas = {};
    entry.files.forEach(f => {
      const ext = f.name.includes('.') ? f.name.split('.').pop() : 'code';
      files[f.name] = { ext, label: labelFromFileName(f.name) };
      shas[f.name] = f.sha;
    });

    const realUpdatedAt = await fetchLastCommitDate(token, hook, folderPath);
    const cached = existingProblems[slug];
    if (cached) {
      // Known to this browser: retain locally cached title and category metadata, refreshing only file listings and commit timestamps.
      // NOTE: Cached metadata is richer than tree path fragments, while GitHub commit dates prevent timestamp drift.
      reconciledProblems[slug] = {
        ...cached,
        folderPath,
        files,
        updatedAt: realUpdatedAt || cached.updatedAt || null
      };
    } else {
      // Unknown to this browser (e.g. fresh install, cleared storage, or different machine).
      // NOTE: Uses placeholder metadata derived from path structure to avoid an expensive API call per unknown problem folder.
      reconciledProblems[slug] = {
        title: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        difficulty: 'Medium',
        folderPath,
        codeFileName: entry.files[0].name,
        languages: {},
        files,
        updatedAt: realUpdatedAt || null
      };
    }
    reconciledShas[slug] = shas;
  }));

  const duplicateSlugEntries = Array.from(slugToFolders.entries()).filter(([, folderPaths]) => folderPaths.length > 1);
  const duplicates = await Promise.all(duplicateSlugEntries.map(async ([slug, folderPaths]) => ({
    slug,
    folders: await Promise.all(folderPaths.map(async folderPath => {
      const entry = folders.get(folderPath);
      const paths = entry.files.map(f => `${folderPath}/${f.name}`);
      if (entry.hasReadme) paths.push(`${folderPath}/README.md`);
      const lastModified = await fetchLastCommitDate(token, hook, folderPath);
      return { folderPath, files: paths, lastModified };
    }))
  })));

  const solvedSlugs = Object.keys(reconciledProblems);
  const counts = { solved: solvedSlugs.length, easy: 0, medium: 0, hard: 0 };
  solvedSlugs.forEach(slug => {
    const bucket = classifyDifficulty(reconciledProblems[slug].difficulty);
    if (bucket === 'easy') counts.easy++;
    else if (bucket === 'hard') counts.hard++;
    else counts.medium++; // folds 'unspecified' in too, same as computeUpdatedStats' tally
  });

  const hierarchy = {};
  solvedSlugs.forEach(slug => {
    const p = reconciledProblems[slug];
    if (p.mainTopic) {
      hierarchy[p.mainTopic] = hierarchy[p.mainTopic] || {};
      hierarchy[p.mainTopic][p.subTopic || 'General'] = true;
    }
  });

  // Keeps a code hash only while its exact file still exists in the live tree, so a deleted or moved file can be synced again with identical code.
  // NOTE: Hashes are keyed by full repo path (folderPath/fileName), so the tree lookup is exact rather than a slug prefix match.
  // NOTE: Slug-keyed entries (slug::fileName) from older versions are dropped here because nothing reads them anymore.
  const removedSlugs = Object.keys(existingProblems).filter(slug => !liveSlugs.has(slug));
  const hashData = await safeGetStorage('tufhub_code_hashes');
  const codeHashes = hashData.tufhub_code_hashes || {};
  const purgedHashes = {};
  Object.keys(codeHashes).forEach(key => {
    if (key.includes('::')) return;
    const cut = key.lastIndexOf('/');
    const entry = cut > 0 ? folders.get(key.slice(0, cut)) : null;
    if (entry && entry.files.some(f => f.name === key.slice(cut + 1))) purgedHashes[key] = codeHashes[key];
  });

  // Debounce timestamps stay slug-keyed (slug::fileName), so removed problems are purged by their slug prefix.
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
    const readmeRes = await ghGet(`https://api.github.com/repos/${hook}/contents/README.md`, token);
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
    return { ok: true, reason: 'unchanged', stats: reconciledStats, duplicates };
  }

  let uploadResult;
  try {
    uploadResult = await uploadToGitHub(
      token,
      hook,
      'README.md',
      generatedContent,
      'Update ROOT README.md problem index (TUFHub manual sync)',
      readmeSha
    );
  } catch (e) {
    // Repo remains untouched on write failure: local stats are intentionally not updated so retry starts clean.
    return { ok: false, reason: 'error', message: e && e.message };
  }

  // Persisted only after the write succeeds: if the worker dies, the repo remains ground truth and local stats are merely stale.
  // Stale local stats self-heal on next reconcile, whereas saving storage first risks claiming a sync that never reached GitHub.
  await safeSetStorage({ stats: reconciledStats, tufhub_code_hashes: purgedHashes });
  await safeSetStorage({ tufhub_last_reconcile_at: Date.now() });

  return {
    ok: true,
    reason: 'synced',
    stats: reconciledStats,
    removedSlugs,
    duplicates,
    commitSha: uploadResult ? uploadResult.commitSha : '',
    commitUrl: uploadResult ? uploadResult.htmlUrl : ''
  };
}
