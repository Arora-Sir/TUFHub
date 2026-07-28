/**
 * TUFHub Content Script (ISOLATED World)
 * Multi-Category Routing Engine: Prevents Git branch race conditions & 409 conflicts
 * Author: Mohit Arora (@Arora-Sir)
 */

import { buildProblemReadme } from './readme.js';
import { updateRootReadme } from './rootReadme.js';
import { uploadToGitHub } from './uploader.js';
import { resolveHierarchy } from './router.js';
import { getStats, updateStats, isDebounced, safeGetStorage, enqueueOfflineSync, getOfflineQueue, clearOfflineQueue } from './stats.js';
import { showToast } from './toast.js';
import { LANGUAGE_MAP, convertToSlug, addLeadingZeros } from '../util.js';

console.log('%c[TUFHub Content Script] 📥 Multi-category sync engine initialized.', 'color: #8b5cf6; font-weight: bold; font-size: 13px;');

let lastSyncTimestamp = 0;
let isUserSubmitting = false;
let submitTimeout = null;

window.addEventListener('TUFHUB_ACCEPTED_SUBMISSION', async (event) => {
  const data = event.detail;
  console.log('%c[TUFHub Content Script] 🎯 TUFHUB_ACCEPTED_SUBMISSION event received!', 'color: #ec4899; font-weight: bold;', data);

  if (!data) return;

  let code = data.code;
  if (!code || code.trim().length === 0) {
    console.log('[TUFHub Content Script] ⚠️ Code empty in payload. Scraping Monaco editor fallback...');
    code = extractCodeFromMonacoFallback();
    if (!code || code.trim().length === 0) {
      console.warn('[TUFHub Content Script] ❌ Could not extract solution code. Skipping.');
      return;
    }
    data.code = code;
  }

  // Deduplicate syncs within 5 seconds
  if (Date.now() - lastSyncTimestamp < 5000) {
    console.log('[TUFHub Content Script] ⏳ Duplicate event ignored (within 5s threshold).');
    return;
  }

  lastSyncTimestamp = Date.now();
  isUserSubmitting = false;
  clearTimeout(submitTimeout);

  await executeGitHubSync(data);
});

function extractCodeFromMonacoFallback() {
  try {
    if (window.monaco && window.monaco.editor) {
      const models = window.monaco.editor.getModels();
      if (models && models.length > 0) {
        const val = models[0].getValue();
        if (val && val.trim().length > 0) return val;
      }
    }
  } catch (e) {}

  try {
    const viewLines = document.querySelectorAll('.view-lines .view-line');
    if (viewLines.length > 0) {
      return Array.from(viewLines).map(line => line.innerText || line.textContent).join('\n');
    }
  } catch (e) {}
  return '';
}

async function executeGitHubSync(data) {
  let rawTitle = data.title;
  if (!rawTitle || rawTitle === 'Unknown Problem' || rawTitle.length > 80) {
    rawTitle = extractTitleFromUrl() || 'Unknown Problem';
  }

  const slug = addLeadingZeros(convertToSlug(rawTitle));
  const routeInfo = resolveHierarchy(data);
  const folderPath = `${routeInfo.folderPath}/${slug}`;

  console.log(`[TUFHub Sync Engine] 🚀 Category: [${routeInfo.category}] Target Path: ${folderPath}`);

  const debounced = await isDebounced(slug, 5000);
  if (debounced) {
    console.log(`[TUFHub Sync Engine] ⏳ Cooldown active for ${slug}. Skipping duplicate.`);
    showToast(`Already synced ${rawTitle} recently.`, 'info');
    return;
  }

  showToast(`Syncing ${rawTitle} [${routeInfo.category}] to GitHub...`, 'syncing');

  try {
    const storage = await safeGetStorage(['tufhub_token', 'tufhub_hook', 'mode_type']);
    const token = storage.tufhub_token;
    const hook = storage.tufhub_hook;

    if (!token || !hook) {
      console.warn('[TUFHub Sync Engine] ❌ Token or Hook missing from storage!');
      showToast('GitHub not connected. Click [Fix it] to link account.', 'error', 'AUTH_REQUIRED', () => {
        chrome.runtime.sendMessage({ type: 'OPEN_POPUP' });
      });
      return;
    }

    const ext = LANGUAGE_MAP[(data.language || '').toLowerCase()] || (routeInfo.category === 'SQL' ? 'sql' : 'cpp');
    const codeFileName = `solution.${ext}`;

    const problemReadmeContent = buildProblemReadme({
      title: rawTitle,
      difficulty: data.difficulty,
      description: data.description,
      url: data.url || window.location.href
    });

    const stats = await getStats();
    const existingShas = stats.shas[slug] || {};

    console.log(`[TUFHub Sync Engine] 📦 File: ${folderPath}/${codeFileName}`);
    console.log('[TUFHub Sync Engine] 📤 Sequential upload chain initiated for repo:', hook);

    // 1. Upload solution code FIRST
    const codeSha = await uploadToGitHub(
      token,
      hook,
      `${folderPath}/${codeFileName}`,
      data.code,
      `Add solution for ${rawTitle} - TUFHub`,
      existingShas[codeFileName] || ''
    );
    console.log('[TUFHub Sync Engine] ✅ Solution code uploaded successfully!');

    // 2. Upload problem README SECOND
    const readmeSha = await uploadToGitHub(
      token,
      hook,
      `${folderPath}/README.md`,
      problemReadmeContent,
      `Create README for ${rawTitle} - TUFHub`,
      existingShas['README.md'] || ''
    );
    console.log('[TUFHub Sync Engine] ✅ Problem README uploaded successfully!');

    const mainTopic = routeInfo.categoryPath;
    const subTopic = routeInfo.category;

    // 3. Update local stats
    const updatedStats = await updateStats(data.difficulty, slug, {
      [codeFileName]: codeSha,
      'README.md': readmeSha
    }, mainTopic, subTopic, {
      title: rawTitle,
      codeFileName,
      folderPath
    });

    // 4. Update root README index THIRD
    try {
      await updateRootReadme(token, hook, mainTopic, subTopic, slug, updatedStats);
      console.log('[TUFHub Sync Engine] ✅ Root README updated successfully!');
    } catch (rootErr) {
      console.warn('[TUFHub Sync Engine] ⚠️ Root README update warning (non-critical):', rootErr);
    }

    // 5. Notify background worker to trigger success badge
    chrome.runtime.sendMessage({ type: 'SHOW_BADGE_SUCCESS' });

    // 6. Show success toast on TUF+ page
    showToast(`Synced ${rawTitle} to GitHub!`, 'success');

  } catch (err) {
    console.error('[TUFHub Sync Engine] ❌ Sync Error:', err);
    let reasonCode = 'SYNC_ERROR';
    if (!navigator.onLine) {
      reasonCode = 'NO_INTERNET';
      await enqueueOfflineSync(data);
      showToast('Network offline. Queued for auto-sync when online.', 'info');
      return;
    } else if (err.message.includes('403')) reasonCode = 'RATE_LIMITED';
    else if (err.message.includes('401')) reasonCode = 'TOKEN_EXPIRED';
    else if (err.message.includes('404')) reasonCode = 'REPO_NOT_FOUND';

    showToast(`Sync Failed: ${err.message}`, 'error', reasonCode, () => {
      chrome.runtime.sendMessage({ type: 'OPEN_POPUP' });
    });
  }
}

async function flushOfflineQueue() {
  const queue = await getOfflineQueue();
  if (queue.length === 0) return;

  console.log(`[TUFHub Sync Engine] 📡 Internet connection restored. Flushing ${queue.length} offline items...`);
  showToast(`Internet restored. Retrying ${queue.length} queued syncs...`, 'syncing');

  await clearOfflineQueue();

  for (const item of queue) {
    try {
      await executeGitHubSync(item.syncData);
    } catch (e) {
      console.error('[TUFHub Sync Engine] ❌ Offline queue flush error:', e);
    }
  }
}

window.addEventListener('online', flushOfflineQueue);

// -------------------------------------------------------------
// DOM Verdict Watcher (Zero-Lag Backup Channel)
// -------------------------------------------------------------
function setupSubmitClickListeners() {
  document.addEventListener('click', (e) => {
    const target = e.target.closest('button, [role="button"], a, div[class*="button"]');
    if (!target) return;

    const text = (target.innerText || target.getAttribute('aria-label') || target.title || '').toLowerCase();
    const className = (target.className || '').toString().toLowerCase();

    if (text.includes('try') || text.includes('run') || text.includes('reset') || text.includes('console')) {
      return;
    }

    const isSubmit = text.includes('submit') || className.includes('submit');
    if (isSubmit) {
      console.log('[TUFHub DOM Watcher] 🚀 Submit button click detected! Watching DOM for verdict...');
      triggerDOMVerdictWatcher();
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.code === 'Enter' || e.keyCode === 13)) {
      console.log('[TUFHub DOM Watcher] 🚀 Ctrl+Enter shortcut detected! Watching DOM for verdict...');
      triggerDOMVerdictWatcher();
    }
  }, true);
}

function triggerDOMVerdictWatcher() {
  isUserSubmitting = true;
  clearTimeout(submitTimeout);

  let checks = 0;
  const interval = setInterval(() => {
    checks++;
    if (!isUserSubmitting || checks > 30) {
      clearInterval(interval);
      isUserSubmitting = false;
      return;
    }

    const bodyText = document.body.innerText || '';
    if (bodyText.includes('Submission Verdict') && bodyText.includes('Accepted')) {
      const match = bodyText.match(/Test Cases Passed\s*:\s*(\d+)\s*\/\s*(\d+)/i);
      if (match) {
        const passed = parseInt(match[1], 10);
        const total = parseInt(match[2], 10);
        if (passed > 0 && passed === total) {
          console.log(`%c[TUFHub DOM Watcher] 🎉 100% Passed DOM Verdict Confirmed (${passed}/${total})!`, 'color: #22c55e; font-weight: bold; font-size: 13px;');
          clearInterval(interval);
          isUserSubmitting = false;

          if (Date.now() - lastSyncTimestamp > 5000) {
            const code = extractCodeFromMonacoFallback();
            const titleElem = document.querySelector('h1, [class*="title"], [class*="problem-name"]');
            const diffElem = document.querySelector('[class*="difficulty"], [class*="badge"]');

            executeGitHubSync({
              code,
              language: window.location.pathname.includes('sql') ? 'sql' : 'cpp',
              title: titleElem ? titleElem.innerText.trim() : extractTitleFromUrl(),
              difficulty: diffElem ? diffElem.innerText.trim() : 'Medium',
              description: '',
              url: window.location.href,
              timestamp: Date.now()
            });
          }
        }
      }
    }
  }, 500);

  submitTimeout = setTimeout(() => {
    isUserSubmitting = false;
    clearInterval(interval);
  }, 15000);
}

function extractTitleFromUrl() {
  try {
    const pathname = window.location.pathname;
    const parts = pathname.split('/').filter(Boolean);
    const lastPart = parts[parts.length - 1];
    if (lastPart && lastPart !== 'problems') {
      return lastPart
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    }
  } catch (e) {}
  return '';
}

// Initialize listeners
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setupSubmitClickListeners();
    flushOfflineQueue();
  });
} else {
  setupSubmitClickListeners();
  flushOfflineQueue();
}
