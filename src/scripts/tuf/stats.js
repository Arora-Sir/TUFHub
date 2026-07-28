/**
 * TUFHub Stats & SHA State Persistence
 * Author: Mohit Arora (@Arora-Sir)
 */

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
  stats.problems[problemSlug] = {
    title: problemMeta.title || problemSlug,
    difficulty: difficulty || 'Medium',
    mainTopic,
    subTopic,
    codeFileName: problemMeta.codeFileName || 'solution.cpp',
    folderPath: problemMeta.folderPath || `${mainTopic}/${subTopic}/${problemSlug}`,
    updatedAt: Date.now()
  };

  await safeSetStorage({ stats });
  return stats;
}

export async function isDebounced(problemSlug, cooldownMs = 5000) { // 5 sec cooldown threshold for test execution
  const stats = await getStats();
  const lastTime = stats.last_sync_time ? stats.last_sync_time[problemSlug] : null;
  if (lastTime && (Date.now() - lastTime < cooldownMs)) {
    return true;
  }
  return false;
}
