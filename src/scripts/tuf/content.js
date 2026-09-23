/**
 * TUFHub Content Script (ISOLATED World)
 * Multi-Category Routing Engine: Prevents Git branch race conditions & 409 conflicts
 * Author: Mohit Arora (@Arora-Sir)
 */

import { buildProblemReadme } from './readme.js';
import { buildRootReadmeFile } from './rootReadme.js';
import { resolveHierarchy } from './router.js';
import {
  getStats,
  updateStats,
  computeUpdatedStats,
  scanAndSyncRepoStats,
  isDebounced,
  safeGetStorage,
  enqueueOfflineSync,
  getOfflineQueue,
  setOfflineQueue,
  isExtensionContextAlive,
  pushDiag,
  updateHealth,
  isCodeIdentical
} from './stats.js';
import { showToast } from './toast.js';
import { LANGUAGE_MAP, convertToSlug, addLeadingZeros, deriveCodeFileName, deriveFileLabel } from '../util.js';

// Wall-clock budget for the DOM backup watcher (5 minutes) measured against Date.now() rather than throttled setInterval ticks.
const DOM_WATCH_MS = 5 * 60 * 1000;

// Keyed by `${url}::${tabLabel}` on window.__TUFHUB_LAST_SYNC_TS__ to prevent duplicate syncs across re-injected scopes.
// Ensures interceptor CustomEvent and DOM backup watcher do not double-commit the same physical submission.
if (!window.__TUFHUB_LAST_SYNC_TS__) window.__TUFHUB_LAST_SYNC_TS__ = {};
let lastSyncTimestamps = window.__TUFHUB_LAST_SYNC_TS__;
let isUserSubmitting = false;
let submitTimeout = null;
let verdictInterval = null;
// Snapshotted at Submit click time to prevent tab-switching during slow judge evaluation from attaching the wrong solution.
let armedTabInfo = { label: '', count: 0 };
let armedCode = '';

// NOTE: Populated from interceptor.js's MAIN-world syllabus cache via the TUFHUB_TOPIC_INFO event (see handleTopicInfo).
// NOTE: The DOM watcher below builds its own submission payload independently of onAcceptedSubmission and processPayload.
// NOTE: Without this bridge, the DOM watcher would only ever see the DOM and keyword fallback chain, never the authoritative topic data.
let cachedTopicInfo = { slug: '', mainTopic: '', subTopic: '' };

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
 * Fire-and-forget wrapper for chrome.runtime.sendMessage that absorbs unhandled rejections if the worker is sleeping.
 */
function safeSendMessage(message) {
  try {
    if (!isExtensionContextAlive()) return;
    const result = chrome.runtime.sendMessage(message);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (e) {}
}

/**
 * Routes commitFiles() through background.js write queue to serialize commits across tabs and popup actions.
 * Throws a reconstructed Error on failure so callers can catch and inspect status codes.
 */
async function sendGitHubCommitMessage(files, commitMessage, slug, codeFileName, code) {
  if (!isExtensionContextAlive()) {
    throw new Error('Extension context invalidated.');
  }
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: 'GITHUB_COMMIT_FILES', files, commitMessage, slug, codeFileName, code
    });
  } catch (e) {
    throw new Error(e && e.message ? e.message : 'Failed to reach background worker.');
  }
  if (!response) {
    throw new Error('No response from background worker (GITHUB_COMMIT_FILES).');
  }
  if (response.success === false) {
    throw new Error(response.error || 'GitHub commit failed.');
  }
  return response; // { success: true, skipped, commitSha?, htmlUrl?, treeSha? }
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

  // Deduplicates sync events within a 5-second window to prevent duplicate submissions from dual channels.
  const syncKey = `${data.url || ''}::${data.tabLabel || ''}`;
  if (Date.now() - (lastSyncTimestamps[syncKey] || 0) < 5000) {
    console.log('[TUFHub Content Script] ⏳ Duplicate event ignored (within 5s threshold).');
    await pushDiag('DROPPED', 'DUPLICATE_WITHIN_5S', 'Both detection channels fired for the same verdict.');
    return;
  }

  lastSyncTimestamps[syncKey] = Date.now();
  isUserSubmitting = false;
  clearTimeout(submitTimeout);
  clearInterval(verdictInterval);

  await executeGitHubSync(data);
}

/**
 * Scrapes the active tab in the isolated world using ARIA role="tab" and aria-selected.
 */
function getActiveTabInfoDOM() {
  try {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'))
      .filter(t => t.querySelector('button[aria-label^="Close "]'));
    if (tabs.length === 0) return { label: '', count: 0 };

    const labelOf = (tab) => {
      const contentDiv = tab.children[1] || tab;
      const clone = contentDiv.cloneNode(true);
      clone.querySelectorAll('button').forEach(b => b.remove());
      return clone.textContent.trim();
    };

    const active = tabs.find(t => t.getAttribute('aria-selected') === 'true');
    const label = labelOf(active || tabs[0]);
    return label ? { label, count: tabs.length } : { label: '', count: 0 };
  } catch (e) {
    return { label: '', count: 0 };
  }
}

/**
 * Scrapes problem difficulty from the header tier button as a fallback for the DOM watcher channel.
 * Defaults to 'Unspecified' when tier buttons have not rendered.
 */
function extractDifficultyFromDOMWatcher() {
  try {
    const h1 = document.querySelector('h1');
    const headerButtons = h1 && h1.parentElement ? Array.from(h1.parentElement.querySelectorAll('button')) : [];
    const tierBtn = headerButtons.find(b => {
      const t = (b.innerText || '').trim().toLowerCase();
      return t && t !== 'hints' && !t.startsWith('companies');
    });
    if (tierBtn) return tierBtn.innerText.trim();

    const diffElem = document.querySelector('[class*="difficulty"]');
    if (diffElem) return diffElem.innerText.trim();
  } catch (e) {}
  return 'Unspecified';
}

function extractCodeFromMonacoFallback() {
  try {
    if (window.monaco && window.monaco.editor) {
      // Primary attempt: read model from active editor instance.
      const editors = window.monaco.editor.getEditors ? window.monaco.editor.getEditors() : [];
      if (editors.length > 0) {
        const activeModel = editors[0].getModel();
        const activeVal = activeModel ? activeModel.getValue() : '';
        if (activeVal && activeVal.trim().length > 0) return activeVal;
      }
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
 * Orchestrates GitHub commit pipeline for an accepted problem submission.
 * Handles slug derivation, deduplication, README generation, and error badge updates.
 */
async function executeGitHubSync(data, opts = {}) {
  const isReplay = !!opts.isReplay;
  let rawTitle = 'Unknown Problem';

  // Wrap slug resolution, debounce check, and network sync inside try block to guarantee error toast on failure.
  try {
    rawTitle = data.title;
    if (!rawTitle || rawTitle === 'Unknown Problem' || rawTitle.length > 80) {
      rawTitle = extractTitleFromUrl() || 'Unknown Problem';
    }

    const routeInfo = resolveHierarchy(data);

    // Learning articles, quiz sets, and prep hub pages are intentionally skipped since no code artifact exists.
    if (routeInfo.supported === false) {
      console.log(`[TUFHub Sync Engine] ⏭️ Unsupported page type (${routeInfo.type}). Skipping sync.`);
      await pushDiag('SKIPPED', 'UNSUPPORTED_PAGE_TYPE', `${routeInfo.type} ${data.url || window.location.href}`);
      return { ok: true, reasonCode: 'UNSUPPORTED_PAGE_TYPE' };
    }

    // Derive slug from URL path segment rather than page title to avoid zero-padded numbering mismatches.
    const slug = routeInfo.slug || addLeadingZeros(convertToSlug(rawTitle));
    const folderPath = `${routeInfo.folderPath}/${slug}`;

    console.log(`[TUFHub Sync Engine] 🚀 Category: [${routeInfo.category}] Target Path: ${folderPath}`);

    // Verify extension context is alive before reading storage or communicating with background worker.
    if (!isExtensionContextAlive()) {
      console.warn('[TUFHub Sync Engine] ❌ Extension context invalidated (extension was updated or reloaded).');
      showToast('TUFHub was updated. Reload this page to resume syncing.', 'error', 'EXTENSION_RELOADED');
      return { ok: false, reasonCode: 'EXTENSION_RELOADED' };
    }

    // File derivation is per-tab: tabLabel and tabCount determine Solution-N or custom filename.
    const ext = LANGUAGE_MAP[(data.language || '').toLowerCase()] || (routeInfo.category === 'SQL' ? 'sql' : 'cpp');
    const codeFileName = deriveCodeFileName(data.tabLabel, data.tabCount, ext);

    // Cooldown is keyed by slug + filename to allow separate solution tabs to sync without blocking each other.
    const debounced = await isDebounced(slug, codeFileName, 5000);
    if (debounced) {
      console.log(`[TUFHub Sync Engine] ⏳ Cooldown active for ${slug}/${codeFileName}. Skipping duplicate.`);
      await pushDiag('SKIPPED', 'COOLDOWN', `${slug}/${codeFileName}`);
      showToast(`Already synced ${rawTitle} recently.`, 'info');
      return { ok: true, reasonCode: 'COOLDOWN' };
    }

    const identical = await isCodeIdentical(slug, codeFileName, data.code);
    if (identical) {
      console.log(`[TUFHub Sync Engine] ⏳ Code is exactly the same for ${slug}/${codeFileName}. Skipping duplicate sync.`);
      await pushDiag('SKIPPED', 'CODE_UNCHANGED', `${slug}/${codeFileName}`);
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

    const problemReadmeContent = buildProblemReadme({
      title: rawTitle,
      difficulty: data.difficulty,
      description: data.description,
      url: data.url || window.location.href
    });

    console.log(`[TUFHub Sync Engine] 📦 File: ${folderPath}/${codeFileName}`);
    console.log('[TUFHub Sync Engine] 📤 Building single atomic commit for repo:', hook);

    const mainCategory = routeInfo.category || 'DSA';
    const mainTopic = routeInfo.mainTopic || 'General';
    const subTopic = routeInfo.subTopic || 'General';
    const problemMeta = {
      title: rawTitle,
      codeFileName,
      fileLabel: deriveFileLabel(data.tabLabel, data.tabCount, ext),
      folderPath
    };

    // Previews updated stats in memory to determine whether root README changes can fold into this commit.
    // Local storage stats are only updated once the commit successfully lands on GitHub.
    // NOTE: computeUpdatedStats and updateStats take (mainTopic, subTopic) parameters, not a category.
    // NOTE: mainCategory has no parameter slot here because it is already embedded in problemMeta.folderPath.
    // NOTE: Passing mainCategory into the mainTopic slot previously pushed every real value one position over.
    const previewStats = computeUpdatedStats(stats, data.difficulty, slug, {}, mainTopic, subTopic, problemMeta);
    const rootReadmeFile = await buildRootReadmeFile(token, hook, previewStats);

    const files = [
      { path: `${folderPath}/${codeFileName}`, content: data.code },
      { path: `${folderPath}/README.md`, content: problemReadmeContent }
    ];
    if (rootReadmeFile) files.push(rootReadmeFile);

    const commitRes = await sendGitHubCommitMessage(
      files,
      `Sync ${rawTitle} [${mainCategory}] (TUFHub)`,
      slug,
      codeFileName,
      data.code
    );

    if (commitRes.skipped) {
      // Catches redundant submissions that completed while waiting in background.js's serialized write queue.
      console.log(`[TUFHub Sync Engine] ⏳ Code is exactly the same for ${slug}/${codeFileName} (caught at write time). Skipping duplicate sync.`);
      await pushDiag('SKIPPED', 'CODE_UNCHANGED', `${slug}/${codeFileName}`);
      showToast(`Exact same code already synced for ${rawTitle}.`, 'info');
      return { ok: true, reasonCode: 'CODE_UNCHANGED' };
    }

    const commitSha = commitRes.commitSha || '';
    const htmlUrl = commitRes.htmlUrl || '';
    console.log(`[TUFHub Sync Engine] ✅ Committed ${files.length} file(s) in one commit (${commitSha.slice(0, 7)})!`);

    // Persist local stats for real now that the commit has actually landed.
    await updateStats(data.difficulty, slug, {
      [codeFileName]: true,
      'README.md': true
    }, mainTopic, subTopic, problemMeta);

    // Notify background worker to trigger success badge
    safeSendMessage({ type: 'SET_BADGE', state: 'success' });

    // Show success toast on TUF+ page with verifiable commit link
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

    return { ok: true, reasonCode: '' };

  } catch (err) {
    console.error('[TUFHub Sync Engine] ❌ Sync Error:', err);
    const message = (err && err.message) ? err.message : String(err);

    if (!isExtensionContextAlive()) {
      safeSendMessage({ type: 'SET_BADGE', state: 'error' });
      showToast('TUFHub was updated. Reload this page to resume syncing.', 'error', 'EXTENSION_RELOADED');
      return { ok: false, reasonCode: 'EXTENSION_RELOADED' };
    }

    // Treats fetch-level network failures as offline so wake-from-sleep errors are safely queued.
    const isNetworkError = (err instanceof TypeError) ||
      /failed to fetch|networkerror|network error|load failed/i.test(message);

    if (!navigator.onLine || isNetworkError) {
      if (!isReplay) await enqueueOfflineSync(data);
      await pushDiag('QUEUED', 'NO_INTERNET', message);
      await updateHealth({ lastFailureAt: Date.now(), lastFailureReason: 'NO_INTERNET' });
      if (!isReplay) {
        const q = await getOfflineQueue();
        safeSendMessage({ type: 'SET_BADGE', state: 'queued', count: q.length });
        showToast('Network unavailable. Queued for auto-sync when back online.', 'info', 'NO_INTERNET');
      }
      return { ok: false, reasonCode: 'NO_INTERNET' };
    }

    // NOTE: Handles branch ref update conflicts that persist after commitTreeEntries internal retries.
    // Enqueues the submission for automatic retry when GitHub ref propagation catches up.
    if (message.includes('Ref Update Conflict')) {
      if (!isReplay) await enqueueOfflineSync(data);
      await pushDiag('QUEUED', 'GITHUB_SYNC_LAG', message);
      await updateHealth({ lastFailureAt: Date.now(), lastFailureReason: `GITHUB_SYNC_LAG: ${message}` });
      if (!isReplay) {
        const q = await getOfflineQueue();
        safeSendMessage({ type: 'SET_BADGE', state: 'queued', count: q.length });
        showToast('GitHub is still catching up from your last sync. This will retry automatically.', 'info', 'GITHUB_SYNC_LAG');
      }
      return { ok: false, reasonCode: 'GITHUB_SYNC_LAG' };
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

// Flush-level retry budget across navigations (maximum 6 attempts) to handle transient git ref lag without retrying forever.
const MAX_QUEUE_ATTEMPTS = 6;

async function flushOfflineQueue() {
  const queue = await getOfflineQueue();
  if (queue.length === 0) return;

  // The queue holds both offline solutions and online ref-conflict retries.
  // NOTE: Retains un-synced items in the queue if replaying fails or if the tab closes mid-flush.
  // NOTE: Clearing the queue up front would permanently lose submissions whenever replay encounters errors.
  console.log(`[TUFHub Sync Engine] 📡 Retrying ${queue.length} queued item(s)...`);
  showToast(`Retrying ${queue.length} queued sync(s)...`, 'syncing');

  const processedIds = new Set(queue.map(item => item.id));
  const remaining = [];
  let gaveUpAny = false;

  for (const item of queue) {
    const attempts = (item.attempts || 0) + 1;
    let failed = false;
    let lastReasonCode = 'unknown';
    try {
      const result = await executeGitHubSync(item.syncData, { isReplay: true });
      if (!result || !result.ok) {
        failed = true;
        lastReasonCode = (result && result.reasonCode) || 'unknown';
      }
    } catch (e) {
      console.error('[TUFHub Sync Engine] ❌ Offline queue flush error:', e);
      failed = true;
      lastReasonCode = (e && e.message) || 'threw';
    }

    if (!failed) continue;

    if (attempts >= MAX_QUEUE_ATTEMPTS) {
      gaveUpAny = true;
      await pushDiag('FAILED', 'QUEUE_GAVE_UP', `${item.syncData?.title || 'item'}: gave up after ${attempts} attempts (${lastReasonCode})`);
    } else {
      remaining.push({ ...item, attempts });
    }
  }

  // Reconciles against a fresh read instead of blindly overwriting queue storage.
  // NOTE: A concurrent tab may enqueue a new submission while this flush loop is actively executing.
  // NOTE: Preserving fresh items outside processedIds prevents race conditions from dropping concurrent syncs.
  const freshQueue = await getOfflineQueue();
  const merged = freshQueue
    .filter(item => !processedIds.has(item.id))
    .concat(remaining);
  await setOfflineQueue(merged);

  if (gaveUpAny) {
    safeSendMessage({ type: 'SET_BADGE', state: 'error' });
    showToast('Some queued syncs could not complete after several attempts. Resubmit them on TUF+ to retry.', 'error', 'QUEUE_GAVE_UP');
  } else if (merged.length > 0) {
    safeSendMessage({ type: 'SET_BADGE', state: 'queued', count: merged.length });
  } else {
    safeSendMessage({ type: 'CLEAR_BADGE' });
  }

  if (remaining.length > 0) {
    await pushDiag('QUEUE_PARTIAL', 'FLUSH_INCOMPLETE', `${remaining.length} item(s) still queued.`);
  }
}

// -------------------------------------------------------------
// DOM Verdict Watcher (Zero-Lag Backup Channel)
// -------------------------------------------------------------
function handleSubmitClick(e) {
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
}

function handleSubmitKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.code === 'Enter' || e.keyCode === 13)) {
    console.log('[TUFHub DOM Watcher] 🚀 Ctrl+Enter shortcut detected! Watching DOM for verdict...');
    registerSubmitIntent();
  }
}

function setupSubmitClickListeners() {
  singletonListener(document, 'click', handleSubmitClick, '__TUFHUB_CLICK_LISTENER__', true);
  singletonListener(document, 'keydown', handleSubmitKeydown, '__TUFHUB_KEYDOWN_LISTENER__', true);
}

/**
 * Arms both detection channels (interceptor and DOM watcher) upon user submit click or shortcut.
 */
function registerSubmitIntent() {
  try {
    window.dispatchEvent(new CustomEvent('TUFHUB_USER_SUBMIT_CLICKED'));
  } catch (e) {}
  armedTabInfo = getActiveTabInfoDOM();
  // Snapshots code immediately at click time to prevent tab switches from capturing the wrong solution.
  const freshCode = extractCodeFromMonacoFallback();
  if (freshCode && freshCode.trim().length > 0) armedCode = freshCode;
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

    // Evaluates test case completion from verdict text, supporting both 'test cases N/M' and 'Passed N/M'.
    const match = bodyText.match(/test\s*cases?\s*(?:passed)?\s*[:\-]?\s*(\d+)\s*\/\s*(\d+)/i) ||
      bodyText.match(/\bPassed\s+(\d+)\s*\/\s*(\d+)/i);
    if (!match) return;

    const passed = parseInt(match[1], 10);
    const total = parseInt(match[2], 10);
    if (!(passed > 0 && passed === total)) return;

    console.log(`%c[TUFHub DOM Watcher] 🎉 100% Passed DOM Verdict Confirmed (${passed}/${total})!`, 'color: #22c55e; font-weight: bold; font-size: 13px;');
    clearInterval(verdictInterval);
    isUserSubmitting = false;

    const domSyncKey = `${window.location.href}::${armedTabInfo.label || ''}`;
    if (Date.now() - (lastSyncTimestamps[domSyncKey] || 0) > 5000) {
      lastSyncTimestamps[domSyncKey] = Date.now();
      // Use code snapshotted at Submit click time over a fresh scrape to prevent tabbing away from corrupting the solution.
      const freshFallback = extractCodeFromMonacoFallback();
      const code = (armedCode && armedCode.trim().length > 0) ? armedCode : freshFallback;
      // Scrape current problem title from page h1 element or URL fallback.
      const h1Elem = document.querySelector('h1');

      pushDiag('VERDICT_ACCEPTED', 'DOM_WATCHER', `${passed}/${total}`);

      // Only trusts cachedTopicInfo when it was populated for this exact slug, since a stale value could otherwise linger from a previous problem if TUFHUB_TOPIC_INFO never re-fired for the current one.
      const currentSlug = window.location.pathname.split('/').filter(Boolean).pop() || '';
      const topicMatch = cachedTopicInfo.slug === currentSlug ? cachedTopicInfo : null;

      executeGitHubSync({
        code,
        language: window.location.pathname.includes('sql') ? 'sql' : 'cpp',
        title: h1Elem ? h1Elem.innerText.trim() : extractTitleFromUrl(),
        difficulty: extractDifficultyFromDOMWatcher(),
        description: '',
        url: window.location.href,
        timestamp: Date.now(),
        tabLabel: armedTabInfo.label,
        tabCount: armedTabInfo.count,
        syllabusMainTopic: topicMatch ? topicMatch.mainTopic : '',
        syllabusSubTopic: topicMatch ? topicMatch.subTopic : ''
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

function handleTopicInfo(event) {
  const d = (event && event.detail) || {};
  if (d.slug) {
    cachedTopicInfo = { slug: d.slug, mainTopic: d.mainTopic || '', subTopic: d.subTopic || '' };
    console.log('[TUFHub Content Script] 🧭 Cached topic info for DOM-watcher fallback:', cachedTopicInfo);
  }
}

function handleDiagEvent(event) {
  const d = (event && event.detail) || {};
  pushDiag(d.stage || 'INTERCEPTOR', d.reasonCode || '', d.detail || '');
  if (d.stage === 'ARMED') {
    updateHealth({ lastSubmitIntentAt: Date.now(), lastSubmitIntentUrl: window.location.href });
  } else if (d.stage === 'VERDICT_ACCEPTED') {
    updateHealth({ lastVerdictAt: Date.now() });
  }
}

function handleUnhandledRejection(event) {
  const reason = event && event.reason;
  const message = (reason && reason.message) ? reason.message : String(reason);
  if (/tufhub/i.test(message) || /github/i.test(message)) {
    pushDiag('UNHANDLED_REJECTION', 'UNCAUGHT', message);
  }
}

/**
 * Registers an idempotent singleton event listener, removing any prior listener registered under stateKey.
 * NOTE: window and document persist across repeated chrome.scripting.executeScript calls into the isolated world.
 * NOTE: Each injection receives a fresh module scope, which would stack duplicate listeners without this cleanup.
 * NOTE: Stacking duplicate listeners would trigger N independent GitHub commits for a single accepted submission.
 */
function singletonListener(target, type, handler, stateKey, useCapture = false) {
  const prev = window[stateKey];
  if (prev) target.removeEventListener(type, prev, useCapture);
  window[stateKey] = handler;
  target.addEventListener(type, handler, useCapture);
}

/**
 * Starts a 60-second periodic queue flush interval for surviving tabs.
 * NOTE: ensureScriptsInjected only injects when TUFHUB_PING goes unanswered, so surviving tabs do not re-run init.
 * NOTE: A periodic in-tab flush ensures queued items replay even without network state changes or page reloads.
 */
function startQueueFlushInterval() {
  if (window.__TUFHUB_QUEUE_INTERVAL__) clearInterval(window.__TUFHUB_QUEUE_INTERVAL__);
  window.__TUFHUB_QUEUE_INTERVAL__ = setInterval(flushOfflineQueue, 60000);
}

// -------------------------------------------------------------
// Initialization (idempotent; re-injection safe)
// -------------------------------------------------------------
function initTUFHub() {
  const version = extensionVersion();
  console.log(`%c[TUFHub Content Script v${version}] 📥 Multi-category sync engine initialized.`, 'color: #8b5cf6; font-weight: bold; font-size: 13px;');

  singletonListener(window, 'TUFHUB_ACCEPTED_SUBMISSION', onAcceptedSubmission, '__TUFHUB_ACCEPTED_LISTENER__');

  // Relay interceptor diagnostics (MAIN world has no chrome.storage access).
  singletonListener(window, 'TUFHUB_DIAG', handleDiagEvent, '__TUFHUB_DIAG_LISTENER__');

  singletonListener(window, 'TUFHUB_TOPIC_INFO', handleTopicInfo, '__TUFHUB_TOPIC_INFO_LISTENER__');

  singletonListener(window, 'online', flushOfflineQueue, '__TUFHUB_ONLINE_LISTENER__');

  // Nothing else surfaces a throw inside the async submission handler.
  singletonListener(window, 'unhandledrejection', handleUnhandledRejection, '__TUFHUB_REJECTION_LISTENER__');

  // Liveness probe used by the background worker before re-injecting.
  try {
    if (window.__TUFHUB_PING_LISTENER__) {
      chrome.runtime.onMessage.removeListener(window.__TUFHUB_PING_LISTENER__);
    }
    const pingListener = (request, sender, sendResponse) => {
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
    };
    window.__TUFHUB_PING_LISTENER__ = pingListener;
    chrome.runtime.onMessage.addListener(pingListener);
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
  startQueueFlushInterval();
}

let shouldInit = false;
if (!window.__TUFHUB_CONTENT_INITED__) {
  shouldInit = true;
} else if (isExtensionContextAlive()) {
  // Re-initializes whenever the current extension context is alive, even if the inited flag was set by an orphaned instance.
  // NOTE: An extension reload in chrome://extensions invalidates old contexts without clearing inited flags in existing tabs.
  // NOTE: Fresh injections from background.js are confirmed alive, so re-initializing ensures valid API bindings.
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
