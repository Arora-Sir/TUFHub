/**
 * TUFHub Content Script (ISOLATED World)
 * Multi-Category Routing Engine: Prevents Git branch race conditions & 409 conflicts
 * Author: Mohit Arora (@Arora-Sir)
 */

import { buildProblemReadme } from './readme.js';
import { updateRootReadme } from './rootReadme.js';
import { uploadToGitHub } from './uploader.js';
import { resolveHierarchy } from './router.js';
import {
  getStats,
  updateStats,
  scanAndSyncRepoStats,
  isDebounced,
  safeGetStorage,
  enqueueOfflineSync,
  getOfflineQueue,
  setOfflineQueue,
  isExtensionContextAlive,
  pushDiag,
  updateHealth,
  isCodeIdentical,
  updateCodeHash
} from './stats.js';
import { showToast } from './toast.js';
import { LANGUAGE_MAP, convertToSlug, addLeadingZeros } from '../util.js';

// Wall-clock budget for the DOM backup watcher. Deliberately generous: a cold
// judge after an idle period routinely takes far longer than the 15s the
// previous build allowed, and setInterval is throttled in background tabs, so
// this is measured against Date.now() rather than a poll count.
const DOM_WATCH_MS = 5 * 60 * 1000;

let lastSyncTimestamp = 0;
let isUserSubmitting = false;
let submitTimeout = null;
let verdictInterval = null;

function extensionVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch (e) {
    return 'unknown';
  }
}

function interceptorVersion() {
  try {
    return document.documentElement.getAttribute('data-tufhub-interceptor') || '';
  } catch (e) {
    return '';
  }
}

/**
 * MV3 sendMessage returns a promise when called without a callback; if the
 * worker cannot be woken or the context is orphaned that becomes an unhandled
 * rejection. Always route fire-and-forget messages through here.
 */
function safeSendMessage(message) {
  try {
    if (!isExtensionContextAlive()) return;
    const result = chrome.runtime.sendMessage(message);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (e) {}
}

async function onAcceptedSubmission(event) {
  const data = event.detail;
  console.log('%c[TUFHub Content Script] 🎯 TUFHUB_ACCEPTED_SUBMISSION event received!', 'color: #ec4899; font-weight: bold;', data);

  if (!data) {
    await pushDiag('DROPPED', 'EMPTY_EVENT_DETAIL', 'CustomEvent arrived with no detail payload.');
    return;
  }

  let code = data.code;
  if (!code || code.trim().length === 0) {
    console.log('[TUFHub Content Script] ⚠️ Code empty in payload. Scraping Monaco editor fallback...');
    code = extractCodeFromMonacoFallback();
    if (!code || code.trim().length === 0) {
      console.warn('[TUFHub Content Script] ❌ Could not extract solution code. Skipping.');
      await pushDiag('DROPPED', 'NO_CODE_EXTRACTED', 'Payload had no code and the Monaco fallback was empty.');
      showToast('Solution accepted, but TUFHub could not read your code. Reload and re-submit.', 'error', 'NO_CODE_EXTRACTED');
      return;
    }
    data.code = code;
  }

  // Deduplicate syncs within 5 seconds (interceptor + DOM watcher can both fire)
  if (Date.now() - lastSyncTimestamp < 5000) {
    console.log('[TUFHub Content Script] ⏳ Duplicate event ignored (within 5s threshold).');
    await pushDiag('DROPPED', 'DUPLICATE_WITHIN_5S', 'Both detection channels fired for the same verdict.');
    return;
  }

  lastSyncTimestamp = Date.now();
  isUserSubmitting = false;
  clearTimeout(submitTimeout);
  clearInterval(verdictInterval);

  await executeGitHubSync(data);
}

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

/**
 * @returns {Promise<{ok: boolean, reasonCode: string}>} so the offline-queue
 * flush can tell a real success from a swallowed failure.
 */
async function executeGitHubSync(data) {
  let rawTitle = 'Unknown Problem';

  // Everything below runs inside the try. In the previous build the slug/route
  // resolution and the debounce check ran *before* it and before the first
  // toast, so any throw there became an unhandled rejection with zero feedback.
  try {
    rawTitle = data.title;
    if (!rawTitle || rawTitle === 'Unknown Problem' || rawTitle.length > 80) {
      rawTitle = extractTitleFromUrl() || 'Unknown Problem';
    }

    const slug = addLeadingZeros(convertToSlug(rawTitle));
    const routeInfo = resolveHierarchy(data);
    const folderPath = `${routeInfo.folderPath}/${slug}`;

    console.log(`[TUFHub Sync Engine] 🚀 Category: [${routeInfo.category}] Target Path: ${folderPath}`);

    // Detect an orphaned content script explicitly. Without this, an extension
    // update under an open tab makes every storage read return {} and the sync
    // engine reports "GitHub not connected", sending you after the wrong bug.
    if (!isExtensionContextAlive()) {
      console.warn('[TUFHub Sync Engine] ❌ Extension context invalidated (extension was updated or reloaded).');
      showToast('TUFHub was updated. Reload this page to resume syncing.', 'error', 'EXTENSION_RELOADED');
      return { ok: false, reasonCode: 'EXTENSION_RELOADED' };
    }

    const debounced = await isDebounced(slug, 5000);
    if (debounced) {
      console.log(`[TUFHub Sync Engine] ⏳ Cooldown active for ${slug}. Skipping duplicate.`);
      await pushDiag('SKIPPED', 'COOLDOWN', slug);
      showToast(`Already synced ${rawTitle} recently.`, 'info');
      return { ok: true, reasonCode: 'COOLDOWN' };
    }

    const identical = await isCodeIdentical(slug, data.code);
    if (identical) {
      console.log(`[TUFHub Sync Engine] ⏳ Code is exactly the same for ${slug}. Skipping duplicate sync.`);
      await pushDiag('SKIPPED', 'CODE_UNCHANGED', slug);
      showToast(`Exact same code already synced for ${rawTitle}.`, 'info');
      return { ok: true, reasonCode: 'CODE_UNCHANGED' };
    }

    await pushDiag('SYNC_START', '', `${slug} -> ${folderPath}`);
    showToast(`Syncing ${rawTitle} [${routeInfo.category}] to GitHub...`, 'syncing');

    const storage = await safeGetStorage(['tufhub_token', 'tufhub_hook', 'mode_type']);
    const token = storage.tufhub_token;
    const hook = storage.tufhub_hook;

    if (!token || !hook) {
      console.warn('[TUFHub Sync Engine] ❌ Token or Hook missing from storage!');
      await pushDiag('FAILED', 'AUTH_REQUIRED', 'No token or repo hook in storage.');
      await updateHealth({ lastFailureAt: Date.now(), lastFailureReason: 'AUTH_REQUIRED' });
      safeSendMessage({ type: 'SET_BADGE', state: 'error' });
      showToast('GitHub not connected. Click to link your account.', 'error', 'AUTH_REQUIRED', () => {
        safeSendMessage({ type: 'OPEN_POPUP' });
      }, 'Connect GitHub');
      return { ok: false, reasonCode: 'AUTH_REQUIRED' };
    }

    // Auto-reconcile local stats with GitHub repo state so deleted repo items are purged
    const stats = (await scanAndSyncRepoStats(token, hook)) || (await getStats());

    const ext = LANGUAGE_MAP[(data.language || '').toLowerCase()] || (routeInfo.category === 'SQL' ? 'sql' : 'cpp');
    const codeFileName = `solution.${ext}`;

    const problemReadmeContent = buildProblemReadme({
      title: rawTitle,
      difficulty: data.difficulty,
      description: data.description,
      url: data.url || window.location.href
    });

    const existingShas = stats.shas[slug] || {};

    console.log(`[TUFHub Sync Engine] 📦 File: ${folderPath}/${codeFileName}`);
    console.log('[TUFHub Sync Engine] 📤 Sequential upload chain initiated for repo:', hook);

    // 1. Upload solution code FIRST
    const codeRes = await uploadToGitHub(
      token,
      hook,
      `${folderPath}/${codeFileName}`,
      data.code,
      `Add solution for ${rawTitle} - TUFHub`,
      existingShas[codeFileName] || ''
    );
    const codeSha = codeRes.contentSha || codeRes;
    const commitSha = codeRes.commitSha || '';
    const htmlUrl = codeRes.htmlUrl || '';
    console.log('[TUFHub Sync Engine] ✅ Solution code uploaded successfully!');

    // 2. Upload problem README SECOND
    const readmeRes = await uploadToGitHub(
      token,
      hook,
      `${folderPath}/README.md`,
      problemReadmeContent,
      `Create README for ${rawTitle} - TUFHub`,
      existingShas['README.md'] || ''
    );
    const readmeSha = readmeRes.contentSha || readmeRes;
    console.log('[TUFHub Sync Engine] ✅ Problem README uploaded successfully!');

    const mainCategory = routeInfo.category || 'DSA';
    const mainTopic = routeInfo.mainTopic || 'General';
    const subTopic = routeInfo.subTopic || 'General';

    // 3. Update local stats
    const updatedStats = await updateStats(data.difficulty, slug, {
      [codeFileName]: codeSha,
      'README.md': readmeSha
    }, mainCategory, mainTopic, {
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
      await pushDiag('WARNING', 'ROOT_README_FAILED', rootErr && rootErr.message);
    }

    // 5. Notify background worker to trigger success badge
    safeSendMessage({ type: 'SET_BADGE', state: 'success' });

    // 6. Show success toast on TUF+ page with verifiable commit link
    await pushDiag('SYNC_OK', '', slug);
    await updateHealth({
      lastSyncAt: Date.now(),
      lastSyncSlug: slug,
      lastSyncPath: `${folderPath}/${codeFileName}`,
      lastCommitSha: commitSha,
      lastCommitUrl: htmlUrl,
      lastFailureReason: ''
    });

    const shortSha = commitSha ? commitSha.slice(0, 7) : '';
    const toastMessage = shortSha ? `Synced ${rawTitle} to GitHub (${shortSha})` : `Synced ${rawTitle} to GitHub!`;

    if (htmlUrl) {
      showToast(toastMessage, 'success', '', () => {
        window.open(htmlUrl, '_blank', 'noopener');
      }, 'View commit');
    } else {
      showToast(toastMessage, 'success');
    }

    await updateCodeHash(slug, data.code);

    return { ok: true, reasonCode: '' };

  } catch (err) {
    console.error('[TUFHub Sync Engine] ❌ Sync Error:', err);
    const message = (err && err.message) ? err.message : String(err);

    if (!isExtensionContextAlive()) {
      safeSendMessage({ type: 'SET_BADGE', state: 'error' });
      showToast('TUFHub was updated. Reload this page to resume syncing.', 'error', 'EXTENSION_RELOADED');
      return { ok: false, reasonCode: 'EXTENSION_RELOADED' };
    }

    // navigator.onLine reports true as soon as an interface is up, which is
    // exactly the state a machine is in right after waking from sleep while the
    // connection is not yet usable. Treat fetch-level failures as offline too,
    // otherwise those syncs were shown once and dropped forever.
    const isNetworkError = (err instanceof TypeError) ||
      /failed to fetch|networkerror|network error|load failed/i.test(message);

    if (!navigator.onLine || isNetworkError) {
      await enqueueOfflineSync(data);
      await pushDiag('QUEUED', 'NO_INTERNET', message);
      await updateHealth({ lastFailureAt: Date.now(), lastFailureReason: 'NO_INTERNET' });
      const q = await getOfflineQueue();
      safeSendMessage({ type: 'SET_BADGE', state: 'queued', count: q.length });
      showToast('Network unavailable. Queued for auto-sync when back online.', 'info', 'NO_INTERNET');
      return { ok: false, reasonCode: 'NO_INTERNET' };
    }

    let reasonCode = 'SYNC_ERROR';
    if (message.includes('403')) reasonCode = 'RATE_LIMITED';
    else if (message.includes('401')) reasonCode = 'TOKEN_EXPIRED';
    else if (message.includes('404')) reasonCode = 'REPO_NOT_FOUND';

    await pushDiag('FAILED', reasonCode, message);
    await updateHealth({ lastFailureAt: Date.now(), lastFailureReason: `${reasonCode}: ${message}` });
    safeSendMessage({ type: 'SET_BADGE', state: 'error' });
    showToast(`Sync Failed: ${message}`, 'error', reasonCode, () => {
      safeSendMessage({ type: 'OPEN_POPUP' });
    }, 'Open Popup');
    return { ok: false, reasonCode };
  }
}

async function flushOfflineQueue() {
  const queue = await getOfflineQueue();
  if (queue.length === 0) return;

  console.log(`[TUFHub Sync Engine] 📡 Flushing ${queue.length} offline items...`);
  showToast(`Internet restored. Retrying ${queue.length} queued syncs...`, 'syncing');

  // Retain anything that does not actually land. The previous build cleared the
  // queue up front, so a failed replay - or a tab close mid-flush - lost the
  // solution permanently.
  const remaining = [];
  for (const item of queue) {
    try {
      const result = await executeGitHubSync(item.syncData);
      if (!result || !result.ok) remaining.push(item);
    } catch (e) {
      console.error('[TUFHub Sync Engine] ❌ Offline queue flush error:', e);
      remaining.push(item);
    }
  }

  await setOfflineQueue(remaining);
  if (remaining.length > 0) {
    await pushDiag('QUEUE_PARTIAL', 'FLUSH_INCOMPLETE', `${remaining.length} item(s) still queued.`);
  }
}

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
      registerSubmitIntent();
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.code === 'Enter' || e.keyCode === 13)) {
      console.log('[TUFHub DOM Watcher] 🚀 Ctrl+Enter shortcut detected! Watching DOM for verdict...');
      registerSubmitIntent();
    }
  }, true);
}

/**
 * Arms both detection channels. The MAIN-world interceptor has always listened
 * for TUFHUB_USER_SUBMIT_CLICKED, but nothing ever dispatched it, so its gate
 * could only be opened by observing the POST /judge/submit response. This gives
 * it a second, independent opener.
 */
function registerSubmitIntent() {
  try {
    window.dispatchEvent(new CustomEvent('TUFHUB_USER_SUBMIT_CLICKED'));
  } catch (e) {}
  updateHealth({ lastSubmitIntentAt: Date.now(), lastSubmitIntentUrl: window.location.href });
  triggerDOMVerdictWatcher();
}

function triggerDOMVerdictWatcher() {
  isUserSubmitting = true;
  clearTimeout(submitTimeout);
  clearInterval(verdictInterval);

  const deadline = Date.now() + DOM_WATCH_MS;

  verdictInterval = setInterval(() => {
    if (!isUserSubmitting || Date.now() > deadline) {
      clearInterval(verdictInterval);
      isUserSubmitting = false;
      return;
    }

    const bodyText = (document.body && document.body.innerText) || '';
    if (!/\bAccepted\b/.test(bodyText)) return;

    // Tolerant of copy changes on TUF's side; the old build required the exact
    // literal "Submission Verdict", so any wording tweak killed this channel.
    const match = bodyText.match(/test\s*cases?\s*(?:passed)?\s*[:\-]?\s*(\d+)\s*\/\s*(\d+)/i);
    if (!match) return;

    const passed = parseInt(match[1], 10);
    const total = parseInt(match[2], 10);
    if (!(passed > 0 && passed === total)) return;

    console.log(`%c[TUFHub DOM Watcher] 🎉 100% Passed DOM Verdict Confirmed (${passed}/${total})!`, 'color: #22c55e; font-weight: bold; font-size: 13px;');
    clearInterval(verdictInterval);
    isUserSubmitting = false;

    if (Date.now() - lastSyncTimestamp > 5000) {
      lastSyncTimestamp = Date.now();
      const code = extractCodeFromMonacoFallback();
      const titleElem = document.querySelector('h1, [class*="title"], [class*="problem-name"]');
      const diffElem = document.querySelector('[class*="difficulty"], [class*="badge"]');

      pushDiag('VERDICT_ACCEPTED', 'DOM_WATCHER', `${passed}/${total}`);

      executeGitHubSync({
        code,
        language: window.location.pathname.includes('sql') ? 'sql' : 'cpp',
        title: titleElem ? titleElem.innerText.trim() : extractTitleFromUrl(),
        difficulty: diffElem ? diffElem.innerText.trim() : 'Medium',
        description: '',
        url: window.location.href,
        timestamp: Date.now()
      }).catch((e) => console.error('[TUFHub Sync Engine] ❌ DOM watcher sync error:', e));
    }
  }, 1000);

  submitTimeout = setTimeout(() => {
    isUserSubmitting = false;
    clearInterval(verdictInterval);
  }, DOM_WATCH_MS);
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

// -------------------------------------------------------------
// Initialization (idempotent - the background worker re-injects this script
// after SPA navigations, and duplicate listeners would double-sync)
// -------------------------------------------------------------
function initTUFHub() {
  const version = extensionVersion();
  console.log(`%c[TUFHub Content Script v${version}] 📥 Multi-category sync engine initialized.`, 'color: #8b5cf6; font-weight: bold; font-size: 13px;');

  window.addEventListener('TUFHUB_ACCEPTED_SUBMISSION', onAcceptedSubmission);

  // Relay interceptor diagnostics (MAIN world has no chrome.storage access).
  window.addEventListener('TUFHUB_DIAG', (event) => {
    const d = (event && event.detail) || {};
    pushDiag(d.stage || 'INTERCEPTOR', d.reasonCode || '', d.detail || '');
    if (d.stage === 'ARMED') {
      updateHealth({ lastSubmitIntentAt: Date.now(), lastSubmitIntentUrl: window.location.href });
    } else if (d.stage === 'VERDICT_ACCEPTED') {
      updateHealth({ lastVerdictAt: Date.now() });
    }
  });

  window.addEventListener('online', flushOfflineQueue);

  // Nothing else surfaces a throw inside the async submission handler.
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event && event.reason;
    const message = (reason && reason.message) ? reason.message : String(reason);
    if (/tufhub/i.test(message) || /github/i.test(message)) {
      pushDiag('UNHANDLED_REJECTION', 'UNCAUGHT', message);
    }
  });

  // Liveness probe used by the background worker before re-injecting.
  try {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request && request.type === 'TUFHUB_PING') {
        sendResponse({
          alive: true,
          version,
          interceptor: interceptorVersion(),
          url: window.location.href
        });
        return true;
      }
      return false;
    });
  } catch (e) {}

  updateHealth({
    contentAlive: true,
    contentVersion: version,
    interceptorVersion: interceptorVersion(),
    lastInitAt: Date.now(),
    lastUrl: window.location.href
  });

  setupSubmitClickListeners();
  flushOfflineQueue();
}

let shouldInit = false;
if (!window.__TUFHUB_CONTENT_INITED__) {
  shouldInit = true;
} else if (isExtensionContextAlive()) {
  // The flag can be stale: it may have been set by an earlier instance that is
  // now orphaned (e.g. the extension was reloaded via chrome://extensions
  // without reloading this tab). That old instance's chrome.* calls are dead,
  // but it cannot signal that here - a dead context can't clear its own flag.
  // The only reliable signal is the opposite: THIS execution only runs at all
  // because background.js just freshly injected it, which means its own
  // context is alive right now. So re-init whenever the current context is
  // alive, regardless of what the flag says. A duplicate listener from the
  // orphaned instance is harmless - it can never complete a chrome.* call, and
  // the 5s dedupe in onAcceptedSubmission absorbs any double-fire.
  console.warn('[TUFHub Content Script] Re-initializing on a freshly injected, live context (flag was set by a prior instance).');
  shouldInit = true;
}

if (shouldInit) {
  window.__TUFHUB_CONTENT_INITED__ = true;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTUFHub);
  } else {
    initTUFHub();
  }
}
