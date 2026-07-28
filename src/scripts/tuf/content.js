/**
 * TUFHub Content Script (ISOLATED World)
 * Strict Submit Trigger: ONLY activates on explicit Submit button clicks / Ctrl+Enter!
 * Author: Mohit Arora (@Arora-Sir)
 */

import { buildProblemReadme } from './readme.js';
import { updateRootReadme } from './rootReadme.js';
import { uploadToGitHub } from './uploader.js';
import { getStats, updateStats, isDebounced, safeGetStorage, enqueueOfflineSync, getOfflineQueue, clearOfflineQueue } from './stats.js';
import { showToast } from './toast.js';
import { LANGUAGE_MAP, convertToSlug, addLeadingZeros, sanitizePathSegment } from '../util.js';

console.log('[TUFHub Debug] Content script loaded with strict submit trigger.');

let lastSyncTimestamp = 0;
let isUserSubmitting = false;
let submitTimeout = null;

window.addEventListener('TUFHUB_ACCEPTED_SUBMISSION', async (event) => {
  const data = event.detail;
  console.log('[TUFHub Debug] Event received in content script:', data);

  if (!data) return;

  // STRICT GUARD: Must be in active user submission window
  if (!isUserSubmitting) {
    console.log('[TUFHub Debug] Ignored event - user is not actively submitting.');
    return;
  }

  let code = data.code;
  if (!code || code.trim().length === 0) {
    console.log('[TUFHub Debug] Code is empty in event payload. Requesting Monaco editor scrape...');
    window.dispatchEvent(new CustomEvent('TUFHUB_TRIGGER_MONACO_SCRAPE'));
    return;
  }

  // Prevent double sync within 5 seconds
  if (Date.now() - lastSyncTimestamp < 5000) {
    console.log('[TUFHub Debug] Duplicate event ignored (within 5s threshold).');
    isUserSubmitting = false;
    return;
  }

  lastSyncTimestamp = Date.now();
  isUserSubmitting = false;
  clearTimeout(submitTimeout);

  await executeGitHubSync(data);
});

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

  console.log('[TUFHub Debug] Processing active submission for hierarchy path:', folderPath);

  const debounced = await isDebounced(slug, 5000);
  if (debounced) {
    console.log(`[TUFHub Debug] Cooldown active for ${slug}. Skipping duplicate.`);
    showToast(`Already synced ${rawTitle} recently.`, 'info');
    return;
  }

  showToast(`Syncing ${rawTitle} to GitHub...`, 'syncing');

  try {
    const storage = await safeGetStorage(['tufhub_token', 'tufhub_hook', 'mode_type']);
    const token = storage.tufhub_token;
    const hook = storage.tufhub_hook;

    if (!token || !hook) {
      console.warn('[TUFHub Debug] Token or Hook missing from storage!');
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

    console.log(`[TUFHub Debug] Target path: ${folderPath}/${codeFileName}`);
    console.log('[TUFHub Debug] Starting parallel uploads to GitHub repo:', hook);

    // 1. Upload solution code and problem README in parallel
    const [codeSha, readmeSha] = await Promise.all([
      uploadToGitHub(token, hook, `${folderPath}/${codeFileName}`, data.code, `Add solution for ${rawTitle} - TUFHub`, existingShas[codeFileName] || ''),
      uploadToGitHub(token, hook, `${folderPath}/README.md`, problemReadmeContent, `Create README for ${rawTitle} - TUFHub`, existingShas['README.md'] || '')
    ]);

    console.log('[TUFHub Debug] Solution code & README uploaded successfully!');

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
      console.log('[TUFHub Debug] Root README updated successfully!');
    } catch (rootErr) {
      console.warn('[TUFHub Debug] Root README update warning (non-critical):', rootErr);
    }

    // 4. Notify background worker to trigger success badge
    chrome.runtime.sendMessage({ type: 'SHOW_BADGE_SUCCESS' });

    // 5. Show success toast on TUF+ page
    showToast(`Synced ${rawTitle} to GitHub!`, 'success');

  } catch (err) {
    console.error('[TUFHub Debug] Sync Error:', err);
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

  console.log(`[TUFHub Debug] Internet connection restored. Flushing ${queue.length} offline items...`);
  showToast(`Internet restored. Retrying ${queue.length} queued syncs...`, 'syncing');

  await clearOfflineQueue();

  for (const item of queue) {
    try {
      await executeGitHubSync(item.syncData);
    } catch (e) {
      console.error('[TUFHub Debug] Offline queue flush error:', e);
    }
  }
}

window.addEventListener('online', flushOfflineQueue);

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

// -------------------------------------------------------------
// STRICT Submit Click & Keyboard Shortcut Listener
// -------------------------------------------------------------
function setupSubmitClickListeners() {
  document.addEventListener('click', (e) => {
    const target = e.target.closest('button, [role="button"], a, div[class*="button"]');
    if (!target) return;

    const text = (target.innerText || target.getAttribute('aria-label') || target.title || '').toLowerCase();
    const className = (target.className || '').toString().toLowerCase();

    // Ignore explicit Try, Run, Reset, Console, Hints, Dislike, Like buttons
    if (
      text.includes('try') || 
      text.includes('run') || 
      text.includes('reset') || 
      text.includes('console') ||
      text.includes('hint') ||
      text.includes('doubt') ||
      text.includes('fact') ||
      text.includes('company') ||
      className.includes('accordion')
    ) {
      return;
    }

    // STRICT MATCH: Must contain "submit" in text, title, aria-label, or className!
    const isSubmit = 
      text.includes('submit') || 
      target.getAttribute('aria-label')?.toLowerCase().includes('submit') ||
      target.getAttribute('title')?.toLowerCase().includes('submit') ||
      className.includes('submit');

    if (isSubmit) {
      console.log('[TUFHub Debug] Explicit Submit button click detected!');
      triggerUserSubmissionWindow();
    }
  }, true); // useCapture = true

  document.addEventListener('keydown', (e) => {
    // Capture Ctrl + Enter / Cmd + Enter
    if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.code === 'Enter' || e.keyCode === 13)) {
      console.log('[TUFHub Debug] Explicit Ctrl+Enter shortcut detected!');
      triggerUserSubmissionWindow();
    }
  }, true); // useCapture = true
}

function triggerUserSubmissionWindow() {
  isUserSubmitting = true;
  clearTimeout(submitTimeout);

  // Active submission window stays open for 15s max waiting for API verdict
  submitTimeout = setTimeout(() => {
    isUserSubmitting = false;
    console.log('[TUFHub Debug] User submission window closed (15s timeout).');
  }, 15000);
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
