/**
 * TUFHub Content Script (ISOLATED World)
 * Strict Trigger: ONLY syncs on "Submit code" (Ctrl+Enter), EXCLUDING "Try..." / "Run"!
 * Author: Mohit Arora (@Arora-Sir)
 */

import { buildProblemReadme } from './readme.js';
import { updateRootReadme } from './rootReadme.js';
import { uploadToGitHub } from './uploader.js';
import { getStats, updateStats, isDebounced, safeGetStorage } from './stats.js';
import { showToast } from './toast.js';
import { LANGUAGE_MAP, convertToSlug, addLeadingZeros, sanitizePathSegment } from '../util.js';

console.log('[TUFHub Debug] Content script loaded in isolated world.');

let lastSyncTimestamp = 0;
let isUserSubmitting = false;
let submitTimeout = null;

window.addEventListener('TUFHUB_ACCEPTED_SUBMISSION', async (event) => {
  const data = event.detail;
  console.log('[TUFHub Debug] Event received in content script:', data);

  if (!data) return;

  // ONLY sync if the user explicitly clicked SUBMIT CODE!
  if (!isUserSubmitting) {
    console.log('[TUFHub Debug] Ignored event - user did not initiate SUBMIT CODE (preventing auto-sync on page load or Try button).');
    return;
  }

  let code = data.code;
  if (!code || code.trim().length === 0) {
    console.log('[TUFHub Debug] Code is empty in event payload. Requesting Monaco editor scrape...');
    window.dispatchEvent(new CustomEvent('TUFHUB_TRIGGER_MONACO_SCRAPE'));
    return;
  }

  // Prevent double sync within 4 seconds
  if (Date.now() - lastSyncTimestamp < 4000) {
    console.log('[TUFHub Debug] Duplicate event ignored (within 4s threshold).');
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

  // Check 3-minute debounce cooldown
  const debounced = await isDebounced(slug, 180000);
  if (debounced) {
    console.log(`[TUFHub Debug] Cooldown active for ${slug} (within 3 min debounce). Skipping.`);
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

    console.log(`[TUFHub Debug] Clean target path: ${folderPath}/${codeFileName}`);
    console.log('[TUFHub Debug] Starting parallel uploads to GitHub repo:', hook);

    // Upload solution code and problem README in parallel
    const [codeSha, readmeSha] = await Promise.all([
      uploadToGitHub(token, hook, `${folderPath}/${codeFileName}`, data.code, `Add solution for ${rawTitle} - TUFHub`, existingShas[codeFileName] || ''),
      uploadToGitHub(token, hook, `${folderPath}/README.md`, problemReadmeContent, `Create README for ${rawTitle} - TUFHub`, existingShas['README.md'] || '')
    ]);

    console.log('[TUFHub Debug] Code & README uploaded successfully. Updating root README...');

    // Update local stats first with detailed problem meta
    const updatedStats = await updateStats(data.difficulty, slug, {
      [codeFileName]: codeSha,
      'README.md': readmeSha
    }, cleanMain, cleanSub, {
      title: rawTitle,
      codeFileName,
      folderPath
    });

    // Update root README problem index table
    await updateRootReadme(token, hook, cleanMain, cleanSub, slug, updatedStats);

    console.log('[TUFHub Debug] Sync process fully completed!');

    // Notify background worker to trigger success badge
    chrome.runtime.sendMessage({ type: 'SHOW_BADGE_SUCCESS' });

    // Show success toast on TUF+ page
    showToast(`Synced ${rawTitle} to GitHub!`, 'success');

  } catch (err) {
    console.error('[TUFHub Debug] Sync Error:', err);
    let reasonCode = 'SYNC_ERROR';
    if (!navigator.onLine) reasonCode = 'NO_INTERNET';
    else if (err.message.includes('403')) reasonCode = 'RATE_LIMITED';
    else if (err.message.includes('401')) reasonCode = 'TOKEN_EXPIRED';
    else if (err.message.includes('404')) reasonCode = 'REPO_NOT_FOUND';

    showToast(`Sync Failed: ${err.message}`, 'error', reasonCode, () => {
      chrome.runtime.sendMessage({ type: 'OPEN_POPUP' });
    });
  }
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

// -------------------------------------------------------------
// Keyboard Shortcut & Click Monitor (STRICT SUBMIT CODE ONLY!)
// -------------------------------------------------------------
function setupSubmitClickListeners() {
  document.addEventListener('click', (e) => {
    const target = e.target.closest('button, [role="button"], [class*="submit"]');
    if (target) {
      const txt = (target.innerText || target.getAttribute('aria-label') || '').toLowerCase();
      // MUST NOT match "Try" or "Run"! Must strictly match "submit" or rocket submit button!
      if (txt.includes('submit') && !txt.includes('try') && !txt.includes('run')) {
        console.log('[TUFHub Debug] Strictly SUBMIT CODE button click detected!');
        triggerUserSubmissionWindow();
      }
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    // Ctrl + Enter = Submit code. (Ctrl + ' is Try... and is EXCLUDED!)
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      console.log('[TUFHub Debug] Strictly Ctrl + Enter SUBMIT shortcut detected!');
      triggerUserSubmissionWindow();
    }
  });
}

function triggerUserSubmissionWindow() {
  isUserSubmitting = true;
  clearTimeout(submitTimeout);

  submitTimeout = setTimeout(() => {
    isUserSubmitting = false;
    console.log('[TUFHub Debug] User submission window closed (15s timeout).');
  }, 15000);

  pollForAcceptedVerdict();
}

function pollForAcceptedVerdict() {
  let checks = 0;
  console.log('[TUFHub Debug] Polling DOM for verdict after SUBMIT CODE click...');
  const interval = setInterval(() => {
    checks++;
    if (!isUserSubmitting) {
      clearInterval(interval);
      return;
    }

    const bodyText = document.body.innerText || '';
    if (bodyText.includes('Accepted') || bodyText.includes('ACCEPTED') || bodyText.includes('Correct Answer')) {
      console.log('[TUFHub Debug] Verdict text confirmed via polling!');
      clearInterval(interval);
      if (Date.now() - lastSyncTimestamp > 4000) {
        window.dispatchEvent(new CustomEvent('TUFHUB_TRIGGER_MONACO_SCRAPE'));
      }
    }
    if (checks > 25) clearInterval(interval);
  }, 500);
}

// Initialize only submit click listeners
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupSubmitClickListeners);
} else {
  setupSubmitClickListeners();
}
