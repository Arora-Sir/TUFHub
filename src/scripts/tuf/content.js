/**
 * TUFHub Content Script (ISOLATED World)
 * Dual-Channel Sync Engine: Network Interceptor + DOM Verdict Watcher
 * Author: Mohit Arora (@Arora-Sir)
 */

import { buildProblemReadme } from './readme.js';
import { updateRootReadme } from './rootReadme.js';
import { uploadToGitHub } from './uploader.js';
import { getStats, updateStats, isDebounced, safeGetStorage, enqueueOfflineSync, getOfflineQueue, clearOfflineQueue } from './stats.js';
import { showToast } from './toast.js';
import { LANGUAGE_MAP, convertToSlug, addLeadingZeros, sanitizePathSegment } from '../util.js';

console.log('%c[TUFHub Content Script] 📥 Dual-channel sync engine initialized.', 'color: #8b5cf6; font-weight: bold; font-size: 13px;');

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
  const { mainTopic, subTopic } = get2TierHierarchyFromDOM();

  const cleanMain = sanitizePathSegment(mainTopic);
  const cleanSub = sanitizePathSegment(subTopic);
  const folderPath = `${cleanMain}/${cleanSub}/${slug}`;

  console.log('[TUFHub Sync Engine] 🚀 Target Hierarchy Path:', folderPath);

  const debounced = await isDebounced(slug, 5000);
  if (debounced) {
    console.log(`[TUFHub Sync Engine] ⏳ Cooldown active for ${slug}. Skipping duplicate.`);
    showToast(`Already synced ${rawTitle} recently.`, 'info');
    return;
  }

  showToast(`Syncing ${rawTitle} to GitHub...`, 'syncing');

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

    const ext = LANGUAGE_MAP[data.language] || 'cpp';
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
    console.log('[TUFHub Sync Engine] 📤 Uploading to GitHub repo:', hook);

    // 1. Upload solution code and problem README in parallel
    const [codeSha, readmeSha] = await Promise.all([
      uploadToGitHub(token, hook, `${folderPath}/${codeFileName}`, data.code, `Add solution for ${rawTitle} - TUFHub`, existingShas[codeFileName] || ''),
      uploadToGitHub(token, hook, `${folderPath}/README.md`, problemReadmeContent, `Create README for ${rawTitle} - TUFHub`, existingShas['README.md'] || '')
    ]);

    console.log('[TUFHub Sync Engine] ✅ Solution code & README uploaded successfully!');

    // 2. Update local stats
    const updatedStats = await updateStats(data.difficulty, slug, {
      [codeFileName]: codeSha,
      'README.md': readmeSha
    }, cleanMain, cleanSub, {
      title: rawTitle,
      codeFileName,
      folderPath
    });

    // 3. Update root README index (Fail-safe wrapper)
    try {
      await updateRootReadme(token, hook, cleanMain, cleanSub, slug, updatedStats);
      console.log('[TUFHub Sync Engine] ✅ Root README updated successfully!');
    } catch (rootErr) {
      console.warn('[TUFHub Sync Engine] ⚠️ Root README update warning (non-critical):', rootErr);
    }

    // 4. Notify background worker to trigger success badge
    chrome.runtime.sendMessage({ type: 'SHOW_BADGE_SUCCESS' });

    // 5. Show success toast on TUF+ page
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
    if (!isUserSubmitting || checks > 30) { // 15 seconds max
      clearInterval(interval);
      isUserSubmitting = false;
      return;
    }

    // Check for DOM verdict: "Submission Verdict: Accepted" + "Test Cases Passed : X/X"
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
              language: 'cpp',
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

function get2TierHierarchyFromDOM() {
  let mainTopic = 'DSA';
  let subTopic = 'General';

  try {
    const pathname = window.location.pathname.toLowerCase();
    
    if (pathname.includes('linked-list') || pathname.includes('ll')) mainTopic = 'Linked List';
    else if (pathname.includes('array') || pathname.includes('sorting')) mainTopic = 'Arrays';
    else if (pathname.includes('binary-search')) mainTopic = 'Binary Search';
    else if (pathname.includes('recursion')) mainTopic = 'Recursion';
    else if (pathname.includes('tree') || pathname.includes('bst')) mainTopic = 'Trees';
    else if (pathname.includes('graph')) mainTopic = 'Graphs';
    else if (pathname.includes('dp') || pathname.includes('dynamic-programming')) mainTopic = 'Dynamic Programming';
    else if (pathname.includes('string')) mainTopic = 'Strings';
    else if (pathname.includes('stack') || pathname.includes('queue')) mainTopic = 'Stack & Queue';
    else if (pathname.includes('bit')) mainTopic = 'Bit Manipulation';
    else if (pathname.includes('greedy')) mainTopic = 'Greedy';

    const bodyText = document.body.innerText || '';
    if (bodyText.includes('FAQs (Medium)') || bodyText.includes('FAQs Medium')) subTopic = 'FAQs Medium';
    else if (bodyText.includes('FAQs (Hard)') || bodyText.includes('FAQs Hard')) subTopic = 'FAQs Hard';
    else if (bodyText.includes('Fundamentals (Single LL)') || bodyText.includes('Fundamentals Single LL')) subTopic = 'Fundamentals Single LL';
    else if (bodyText.includes('Fundamentals (Doubly LL)') || bodyText.includes('Fundamentals Doubly LL')) subTopic = 'Fundamentals Doubly LL';
    else if (bodyText.includes('Logic Building')) subTopic = 'Logic Building';

  } catch (e) {}

  return { mainTopic, subTopic };
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
