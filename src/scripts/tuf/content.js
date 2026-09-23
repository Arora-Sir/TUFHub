/**
 * TUFHub Content Script (ISOLATED World)
 * Captures each submission's page context at submit intent, turns an accepted verdict into one frozen sync job, and hands it to the background worker.
 * Never commits, queues, or replays anything itself: once a job is handed off, the background worker owns it until it lands or fails.
 * Author: Mohit Arora (@Arora-Sir)
 */

import { captureTopicHints } from './router.js';
import { buildSyncJob } from './syncJob.js';
import { getStats, isExtensionContextAlive, pushDiag, updateHealth } from './stats.js';
import { showToast } from './toast.js';
import { titleFromSlug } from '../util.js';

// Wall-clock budget for the DOM backup watcher (5 minutes) measured against Date.now() rather than throttled setInterval ticks.
const DOM_WATCH_MS = 5 * 60 * 1000;
// Intent records outlive the interceptor's 10-minute pending window, so a late verdict still finds its topic hints.
const INTENT_TTL_MS = 15 * 60 * 1000;
// When the interceptor is alive for a submission, the DOM watcher waits this many one-second ticks so the richer primary payload wins the race.
const DOM_WATCHER_GRACE_TICKS = 3;

// NOTE: Intents, claimed tokens, and settled job ids live on window because the isolated world's window outlives each injected module scope.
// NOTE: After a re-injection, a fresh module scope would otherwise forget which submissions were already claimed and let the other channel sync them again.
if (!window.__TUFHUB_INTENTS__) window.__TUFHUB_INTENTS__ = {};
if (!window.__TUFHUB_CLAIMED_TOKENS__) window.__TUFHUB_CLAIMED_TOKENS__ = {};
if (!window.__TUFHUB_SETTLED_JOBS__) window.__TUFHUB_SETTLED_JOBS__ = {};
const intents = window.__TUFHUB_INTENTS__;
const claimedTokens = window.__TUFHUB_CLAIMED_TOKENS__;
const settledJobs = window.__TUFHUB_SETTLED_JOBS__;

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

function currentSlug() {
  return (window.location.pathname.split('/').filter(Boolean).pop() || '').toLowerCase();
}

function slugOfUrl(url) {
  try {
    return (new URL(url).pathname.split('/').filter(Boolean).pop() || '').toLowerCase();
  } catch (e) {
    return '';
  }
}

function newToken() {
  return `tok_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function pruneRecords() {
  const now = Date.now();
  Object.keys(intents).forEach((token) => {
    if (now - (intents[token].at || 0) > INTENT_TTL_MS) delete intents[token];
  });
  Object.keys(claimedTokens).forEach((token) => {
    if (now - claimedTokens[token] > INTENT_TTL_MS) delete claimedTokens[token];
  });
  Object.keys(settledJobs).forEach((jobId) => {
    if (now - settledJobs[jobId] > INTENT_TTL_MS) delete settledJobs[jobId];
  });
}

// Claims a submission for exactly one detection channel. The second channel to arrive for the same token is dropped.
function claimToken(token) {
  pruneRecords();
  if (claimedTokens[token]) return false;
  claimedTokens[token] = Date.now();
  return true;
}

// -------------------------------------------------------------
// Isolated-world page readers (fallback snapshot only)
// -------------------------------------------------------------

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

// The isolated world cannot see the page's window.monaco, so this reads rendered lines, sorted by offset because Monaco recycles line nodes while scrolling.
// Only lines inside the viewport are rendered, which is why the interceptor's Monaco snapshot is always preferred over this.
function readVisibleEditorLines() {
  try {
    const containers = Array.from(document.querySelectorAll('.view-lines'));
    const container = containers.find(c => c.offsetParent !== null) || containers[0];
    if (!container) return '';
    const text = Array.from(container.querySelectorAll('.view-line'))
      .map(el => ({ top: parseFloat(el.style.top) || 0, text: (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ') }))
      .sort((a, b) => a.top - b.top)
      .map(line => line.text)
      .join('\n');
    return text.trim() ? text : '';
  } catch (e) {
    return '';
  }
}

// Evaluates test case completion from verdict text, supporting both 'test cases N/M' and 'Passed N/M'.
function readAcceptedVerdict() {
  const bodyText = (document.body && document.body.innerText) || '';
  if (!/\bAccepted\b/.test(bodyText)) return null;
  const match = bodyText.match(/test\s*cases?\s*(?:passed)?\s*[:\-]?\s*(\d+)\s*\/\s*(\d+)/i) ||
    bodyText.match(/\bPassed\s+(\d+)\s*\/\s*(\d+)/i);
  if (!match) return null;
  const passed = parseInt(match[1], 10);
  const total = parseInt(match[2], 10);
  return passed > 0 && passed === total ? { passed, total } : null;
}

/**
 * Degraded snapshot taken in the isolated world at submit intent.
 * Used only when the interceptor never supplied one (not injected yet, or an older build still loaded in this tab until it reloads).
 */
function captureFallbackSnapshot() {
  const slug = currentSlug();
  const tabInfo = getActiveTabInfoDOM();
  const code = readVisibleEditorLines();
  const h1 = document.querySelector('h1');
  const h1Title = h1 ? (h1.innerText || '').trim() : '';
  return {
    url: window.location.href,
    slug,
    code,
    codeSource: code ? 'dom-lines' : '',
    language: window.location.pathname.toLowerCase().includes('/sql/') ? 'sql' : '',
    tabLabel: tabInfo.label,
    tabCount: tabInfo.count,
    title: h1Title || titleFromSlug(slug),
    titleSource: h1Title ? 'h1' : 'slug',
    difficulty: extractDifficultyFromDOMWatcher()
  };
}

// -------------------------------------------------------------
// Submit intents
// -------------------------------------------------------------

function rememberIntent(intent) {
  pruneRecords();
  intents[intent.token] = intent;
  return intent;
}

// Page-side context for one submission, captured while the submitted problem is still on screen.
function createIntent(token, fromClick, snapshot) {
  return rememberIntent({
    token,
    at: Date.now(),
    slug: snapshot && snapshot.slug ? String(snapshot.slug).toLowerCase() : currentSlug(),
    url: snapshot && snapshot.url ? snapshot.url : window.location.href,
    hints: captureTopicHints(),
    fallback: fromClick ? captureFallbackSnapshot() : null,
    snapshot: snapshot || null,
    acceptedVisibleAtStart: !!readAcceptedVerdict(),
    fromClick
  });
}

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
 * Records a submit intent and arms both detection channels, before the page's own handler reads the editor.
 * NOTE: The intent is stored before the event is dispatched, because the interceptor answers with its snapshot synchronously inside dispatchEvent.
 */
function registerSubmitIntent() {
  const token = newToken();
  const intent = createIntent(token, true, null);
  try {
    window.dispatchEvent(new CustomEvent('TUFHUB_USER_SUBMIT_CLICKED', { detail: token }));
  } catch (e) {}
  updateHealth({ lastSubmitIntentAt: Date.now(), lastSubmitIntentUrl: window.location.href });
  startDomWatcher(intent);
}

// Receives the interceptor's frozen snapshot, including submissions that started without a detected click (icon-only button, unrecognized shortcut).
function onSubmissionSnapshot(event) {
  const d = event && event.detail;
  if (!d || !d.token || !d.snapshot) return;
  const intent = intents[d.token];
  if (intent) {
    intent.snapshot = d.snapshot;
    return;
  }
  startDomWatcher(createIntent(d.token, false, d.snapshot));
}

// -------------------------------------------------------------
// DOM verdict watcher (backup channel)
// -------------------------------------------------------------

function stopDomWatcher() {
  if (window.__TUFHUB_WATCHER_INTERVAL__) {
    clearInterval(window.__TUFHUB_WATCHER_INTERVAL__);
    window.__TUFHUB_WATCHER_INTERVAL__ = null;
  }
  window.__TUFHUB_WATCHER_TOKEN__ = '';
}

/**
 * Polls the rendered page for an accepted verdict, covering API response shapes the interceptor does not recognize.
 * NOTE: A verdict counts only after the page showed no accepted verdict at some point since the click, so the previous submission's result panel cannot trigger a sync.
 * NOTE: The watcher stops once the tab leaves the submitted problem, because a verdict rendered after that belongs to a different problem.
 */
function startDomWatcher(intent) {
  stopDomWatcher();
  const state = {
    token: intent.token,
    slug: intent.slug,
    sawClear: !intent.acceptedVisibleAtStart,
    deadline: Date.now() + DOM_WATCH_MS,
    graceTicks: 0
  };
  window.__TUFHUB_WATCHER_TOKEN__ = intent.token;
  window.__TUFHUB_WATCHER_INTERVAL__ = setInterval(() => tickDomWatcher(state), 1000);
}

function tickDomWatcher(state) {
  if (Date.now() > state.deadline || claimedTokens[state.token]) {
    stopDomWatcher();
    return;
  }
  if (currentSlug() !== state.slug) {
    stopDomWatcher();
    pushDiag('DISARMED', 'DOM_WATCHER_NAVIGATED_AWAY', state.slug);
    return;
  }

  const verdict = readAcceptedVerdict();
  if (!verdict) {
    state.sawClear = true;
    return;
  }
  if (!state.sawClear) return;

  const intent = intents[state.token];
  if (intent && intent.snapshot && state.graceTicks < DOM_WATCHER_GRACE_TICKS) {
    state.graceTicks += 1;
    return;
  }

  stopDomWatcher();
  if (!intent || !claimToken(state.token)) return;

  console.log(`%c[TUFHub DOM Watcher] 🎉 100% Passed DOM Verdict Confirmed (${verdict.passed}/${verdict.total})!`, 'color: #22c55e; font-weight: bold; font-size: 13px;');
  pushDiag('VERDICT_ACCEPTED', 'DOM_WATCHER', `${verdict.passed}/${verdict.total}`);
  processAcceptedPayload(payloadFromIntent(intent), 'dom-watcher')
    .catch((e) => console.error('[TUFHub Sync Engine] ❌ DOM watcher sync error:', e));
}

// The DOM watcher syncs the interceptor's frozen snapshot whenever one arrived, so both channels commit identical data. The isolated-world fallback covers submissions without one.
function payloadFromIntent(intent) {
  const snap = intent.snapshot;
  const fb = intent.fallback || {};
  if (snap) {
    return {
      token: intent.token,
      code: snap.code || fb.code || '',
      codeSource: snap.code ? snap.codeSource : (fb.codeSource || ''),
      language: snap.requestLanguage || snap.languageId || snap.domLanguage || fb.language || '',
      title: snap.title,
      titleSource: snap.titleSource,
      difficulty: snap.difficulty,
      description: snap.description || '',
      url: snap.url || intent.url,
      tabLabel: snap.tabLabel,
      tabCount: snap.tabCount,
      syllabusMainTopic: snap.syllabusMainTopic || '',
      syllabusSubTopic: snap.syllabusSubTopic || '',
      topicHints: intent.hints
    };
  }
  return {
    token: intent.token,
    code: fb.code || '',
    codeSource: fb.codeSource || '',
    language: fb.language || '',
    title: fb.title || '',
    titleSource: fb.titleSource || 'slug',
    difficulty: fb.difficulty || 'Unspecified',
    description: '',
    url: fb.url || intent.url,
    tabLabel: fb.tabLabel || '',
    tabCount: fb.tabCount || 0,
    syllabusMainTopic: '',
    syllabusSubTopic: '',
    topicHints: intent.hints
  };
}

// -------------------------------------------------------------
// Interceptor channel and job hand-off
// -------------------------------------------------------------

// Stand-in token for an event from an interceptor build older than the token protocol (still loaded until the tab reloads), matched to the latest intent on the same problem.
function tokenForUntokenedEvent(data) {
  const slug = slugOfUrl(data.url);
  let latest = null;
  Object.values(intents).forEach((intent) => {
    if (intent.slug === slug && (!latest || intent.at > latest.at)) latest = intent;
  });
  return latest ? latest.token : `untokened_${Date.now().toString(36)}`;
}

async function onAcceptedSubmission(event) {
  const data = event.detail;
  console.log('%c[TUFHub Content Script] 🎯 TUFHUB_ACCEPTED_SUBMISSION event received!', 'color: #ec4899; font-weight: bold;', data);

  if (!data) {
    await pushDiag('DROPPED', 'EMPTY_EVENT_DETAIL', 'CustomEvent arrived with no detail payload.');
    return;
  }

  const token = data.token || tokenForUntokenedEvent(data);
  if (!claimToken(token)) {
    console.log('[TUFHub Content Script] ⏳ Duplicate event ignored (the other channel already claimed this submission).');
    await pushDiag('DROPPED', 'DUPLICATE_CHANNEL', 'Both detection channels fired for the same submission.');
    return;
  }
  if (window.__TUFHUB_WATCHER_TOKEN__ === token) stopDomWatcher();

  const intent = intents[token];
  await processAcceptedPayload({ ...data, token, topicHints: intent ? intent.hints : null }, 'interceptor');
}

async function processAcceptedPayload(payload, source) {
  if (!payload.code || !payload.code.trim()) {
    console.warn('[TUFHub Content Script] ❌ Could not extract solution code. Skipping.');
    await pushDiag('DROPPED', 'NO_CODE_EXTRACTED', `${source}: the submission snapshot had no code.`);
    showToast('Solution accepted, but TUFHub could not read your code. Reload and re-submit.', 'error', 'NO_CODE_EXTRACTED');
    return;
  }

  if (!isExtensionContextAlive()) {
    console.warn('[TUFHub Sync Engine] ❌ Extension context invalidated (extension was updated or reloaded).');
    showToast('TUFHub was updated. Reload this page to resume syncing.', 'error', 'EXTENSION_RELOADED');
    return;
  }

  let built;
  try {
    built = buildSyncJob(payload, await getStats(), source);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await pushDiag('FAILED', 'JOB_BUILD_ERROR', message);
    showToast(`Sync Failed: ${message}`, 'error', 'JOB_BUILD_ERROR');
    return;
  }

  // Learning articles, quiz sets, and prep hub pages are intentionally skipped since no code artifact exists.
  if (built.skipReason) {
    console.log(`[TUFHub Sync Engine] ⏭️ Unsupported page type (${built.route.type}). Skipping sync.`);
    await pushDiag('SKIPPED', built.skipReason, `${built.route.type} ${payload.url || ''}`);
    return;
  }

  console.log(`[TUFHub Sync Engine] 🚀 Category: [${built.job.category}] Target: ${built.job.folderPath}/${built.job.codeFileName}`);
  await submitSyncJob(built.job);
}

/**
 * Hands a frozen job to the background worker, which persists it before replying.
 * The worker owns the job from here. This tab renders the status the worker reports back for it.
 */
async function submitSyncJob(job) {
  let ack = null;
  try {
    ack = await chrome.runtime.sendMessage({ type: 'SYNC_JOB', job });
  } catch (e) {
    if (!isExtensionContextAlive()) {
      showToast('TUFHub was updated. Reload this page to resume syncing.', 'error', 'EXTENSION_RELOADED');
      return;
    }
    ack = { accepted: false, reasonCode: 'WORKER_UNREACHABLE', error: (e && e.message) || 'Failed to reach background worker.' };
  }
  if (!ack) ack = { accepted: false, reasonCode: 'WORKER_UNREACHABLE', error: 'No response from background worker.' };

  if (ack.accepted === false) {
    if (ack.reasonCode === 'AUTH_REQUIRED') {
      showToast('GitHub not connected. Click to link your account.', 'error', 'AUTH_REQUIRED', () => {
        safeSendMessage({ type: 'OPEN_POPUP' });
      }, 'Connect GitHub');
      return;
    }
    await pushDiag('FAILED', ack.reasonCode || 'SYNC_ERROR', ack.error || '');
    showToast(`Sync Failed: ${ack.error || ack.reasonCode}`, 'error', ack.reasonCode || 'SYNC_ERROR', () => {
      safeSendMessage({ type: 'OPEN_POPUP' });
    }, 'Open Popup');
    return;
  }

  if (ack.duplicate) {
    console.log(`[TUFHub Sync Engine] ⏳ ${job.folderPath}/${job.codeFileName} is already queued with identical code.`);
    await pushDiag('SKIPPED', 'DUPLICATE_JOB', `${job.folderPath}/${job.codeFileName}`);
    showToast(`${job.title} is already syncing.`, 'info');
    return;
  }

  // A fast worker can finish (for example CODE_UNCHANGED) before this acknowledgement is processed, and its final toast must not be replaced by "Syncing".
  if (!settledJobs[job.id]) showToast(`Syncing ${job.title} [${job.category}] to GitHub...`, 'syncing');
}

function queuedToastMessage(reasonCode) {
  if (reasonCode === 'NO_INTERNET') return 'Network unavailable. Queued for auto-sync when back online.';
  if (reasonCode === 'GITHUB_SYNC_LAG') return 'GitHub is still catching up from your last sync. This will retry automatically.';
  if (reasonCode === 'RATE_LIMITED') return 'GitHub rate limit reached. This will retry automatically.';
  return 'Sync hit a temporary error. This will retry automatically.';
}

/**
 * Renders the worker's status for a job this tab submitted.
 * NOTE: Progress and success toasts appear only while this tab still shows the submitted problem, so a result never pops up over a different problem.
 * NOTE: A final failure shows regardless, since it needs the user to act, and it names the problem and category so it cannot be mistaken for the page on screen.
 */
function handleSyncStatus(msg) {
  if (msg.state !== 'queued') settledJobs[msg.jobId] = Date.now();
  const onSameProblem = currentSlug() === String(msg.slug || '').toLowerCase();

  if (msg.state === 'success') {
    if (!onSameProblem) return;
    const shortSha = (msg.commitSha || '').slice(0, 7);
    const text = shortSha ? `Synced ${msg.title} to GitHub (${shortSha})` : `Synced ${msg.title} to GitHub!`;
    if (msg.htmlUrl) {
      showToast(text, 'success', '', () => {
        window.open(msg.htmlUrl, '_blank', 'noopener');
      }, 'View commit');
    } else {
      showToast(text, 'success');
    }
  } else if (msg.state === 'skipped') {
    if (onSameProblem) showToast(`Exact same code already synced for ${msg.title}.`, 'info');
  } else if (msg.state === 'queued') {
    if (onSameProblem && msg.firstFailure) showToast(queuedToastMessage(msg.reasonCode), 'info', msg.reasonCode);
  } else if (msg.state === 'failed') {
    if (msg.reasonCode === 'AUTH_REQUIRED') {
      showToast('GitHub not connected. Click to link your account.', 'error', 'AUTH_REQUIRED', () => {
        safeSendMessage({ type: 'OPEN_POPUP' });
      }, 'Connect GitHub');
    } else {
      showToast(`Sync failed for ${msg.title} [${msg.category}]: ${msg.message || msg.reasonCode}`, 'error', msg.reasonCode, () => {
        safeSendMessage({ type: 'OPEN_POPUP' });
      }, 'Open Popup');
    }
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

// Stops the queue-flush timer and listeners an older build of this script left on the shared isolated-world window, since those builds replayed queued syncs from every open tab.
function retireLegacyHandlers() {
  if (window.__TUFHUB_QUEUE_INTERVAL__) {
    clearInterval(window.__TUFHUB_QUEUE_INTERVAL__);
    window.__TUFHUB_QUEUE_INTERVAL__ = null;
  }
  [['online', '__TUFHUB_ONLINE_LISTENER__'], ['TUFHUB_TOPIC_INFO', '__TUFHUB_TOPIC_INFO_LISTENER__']].forEach(([type, key]) => {
    if (window[key]) {
      window.removeEventListener(type, window[key]);
      window[key] = null;
    }
  });
}

// -------------------------------------------------------------
// Initialization (idempotent; re-injection safe)
// -------------------------------------------------------------
function initTUFHub() {
  const version = extensionVersion();
  console.log(`%c[TUFHub Content Script v${version}] 📥 Multi-category sync engine initialized.`, 'color: #8b5cf6; font-weight: bold; font-size: 13px;');

  retireLegacyHandlers();

  singletonListener(window, 'TUFHUB_ACCEPTED_SUBMISSION', onAcceptedSubmission, '__TUFHUB_ACCEPTED_LISTENER__');

  singletonListener(window, 'TUFHUB_SUBMISSION_SNAPSHOT', onSubmissionSnapshot, '__TUFHUB_SNAPSHOT_LISTENER__');

  // Relay interceptor diagnostics (MAIN world has no chrome.storage access).
  singletonListener(window, 'TUFHUB_DIAG', handleDiagEvent, '__TUFHUB_DIAG_LISTENER__');

  // Nothing else surfaces a throw inside the async submission handler.
  singletonListener(window, 'unhandledrejection', handleUnhandledRejection, '__TUFHUB_REJECTION_LISTENER__');

  // Liveness probe used by the background worker before re-injecting, plus status reports for jobs this tab submitted.
  try {
    if (window.__TUFHUB_PING_LISTENER__) {
      chrome.runtime.onMessage.removeListener(window.__TUFHUB_PING_LISTENER__);
    }
    const runtimeListener = (request, sender, sendResponse) => {
      if (request && request.type === 'TUFHUB_PING') {
        sendResponse({
          alive: true,
          version,
          interceptor: interceptorVersion(),
          url: window.location.href
        });
        return true;
      }
      if (request && request.type === 'TUFHUB_SYNC_STATUS') {
        handleSyncStatus(request);
      }
      return false;
    };
    window.__TUFHUB_PING_LISTENER__ = runtimeListener;
    chrome.runtime.onMessage.addListener(runtimeListener);
  } catch (e) {}

  updateHealth({
    contentAlive: true,
    contentVersion: version,
    interceptorVersion: interceptorVersion(),
    lastInitAt: Date.now(),
    lastUrl: window.location.href
  });

  setupSubmitClickListeners();
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
