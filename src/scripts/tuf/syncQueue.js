/**
 * TUFHub Durable Sync Queue (background service worker only)
 * Owns every sync job from hand-off to landed commit: persistence, dedupe, the commit pipeline, retries, badge, and status reporting.
 * Content scripts only build jobs; nothing here reads a page, so a retry can never pick up another tab's context.
 * Author: Mohit Arora (@Arora-Sir)
 */

import { buildRootReadmeFile } from './rootReadme.js';
import { buildSyncJob } from './syncJob.js';
import { commitFiles } from './uploader.js';
import {
  computeUpdatedStats,
  getStats,
  isCodeIdentical,
  pushDiag,
  scanAndSyncRepoStats,
  updateCodeHash,
  updateHealth,
  updateStats
} from './stats.js';
import { enqueueGitHubWrite } from './writeQueue.js';

export const SYNC_RETRY_ALARM = 'tufhub-sync-retry';

const QUEUE_KEY = 'tufhub_queue';
// Retry budget for jobs that keep failing while GitHub is reachable (ref lag, 5xx, rate limits).
const MAX_ATTEMPTS = 6;
// A job that never lands (a machine offline for a day) expires instead of committing stale code much later.
const MAX_JOB_AGE_MS = 24 * 60 * 60 * 1000;
// chrome.alarms fires no sooner than 30 seconds, so shorter delays run on an in-process timer with the alarm as a wake-up backstop.
const MIN_ALARM_DELAY_MS = 30 * 1000;
const RETRY_DELAYS_MS = [5 * 1000, 30 * 1000, 60 * 1000, 2 * 60 * 1000, 5 * 60 * 1000];
const RATE_LIMIT_DELAYS_MS = [2 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000];
const OFFLINE_RETRY_MS = 60 * 1000;

let queueLock = Promise.resolve();
let drainPromise = null;
let drainRequested = false;
let retryTimer = null;
let runningJobId = '';

// -------------------------------------------------------------
// Toolbar badge
// -------------------------------------------------------------
export function applyBadgeState(badgeData) {
  const { state, count } = badgeData || {};
  if (state === 'success') {
    chrome.action.setBadgeText({ text: 'OK' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '' });
    }, 5000);
  } else if (state === 'error') {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  } else if (state === 'queued') {
    chrome.action.setBadgeText({ text: String(count || 1) });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

function setBadge(state, count) {
  const badgeData = { state, count };
  chrome.storage.local.set({ tufhub_badge: badgeData });
  applyBadgeState(badgeData);
}

// -------------------------------------------------------------
// Queue storage
// -------------------------------------------------------------

// Serializes read-modify-write cycles on the stored queue, so a hand-off arriving mid-drain can never overwrite a retry update, or the reverse.
function withQueueLock(fn) {
  const result = queueLock.then(fn, fn);
  queueLock = result.catch(() => {});
  return result;
}

/**
 * Reads the stored queue, converting items written by older versions (raw page payloads) into frozen jobs once.
 * NOTE: Legacy payloads carry no topic hints, so the pure router can only use their syllabus field, URL params, or keywords, never the page open now.
 * NOTE: The worker has no DOMParser, so a legacy README falls back to tag-stripped text, and it is skipped when the problem's folder already holds one.
 */
async function readQueue() {
  const data = await chrome.storage.local.get(QUEUE_KEY);
  const raw = Array.isArray(data[QUEUE_KEY]) ? data[QUEUE_KEY] : [];
  if (!raw.some(item => !item || !item.job)) return raw;

  const stats = await getStats();
  const queue = [];
  for (const item of raw) {
    if (item && item.job) {
      queue.push(item);
      continue;
    }
    const syncData = item && item.syncData;
    const built = syncData && syncData.code ? buildSyncJob(syncData, stats, 'legacy-queue') : null;
    if (built && built.job) {
      queue.push({ id: built.job.id, job: built.job, attempts: item.attempts || 0, enqueuedAt: item.timestamp || Date.now(), nextAttemptAt: 0 });
    } else {
      await pushDiag('DROPPED', 'LEGACY_QUEUE_UNROUTABLE', (syncData && syncData.title) || 'queued item', (syncData && syncData.url) || '');
    }
  }
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
  return queue;
}

function writeQueue(queue) {
  return chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

// -------------------------------------------------------------
// Hand-off from content scripts
// -------------------------------------------------------------
function isValidJob(job) {
  return !!job && typeof job === 'object' &&
    typeof job.id === 'string' && !!job.id &&
    typeof job.slug === 'string' && !!job.slug &&
    typeof job.folderPath === 'string' && !!job.folderPath &&
    typeof job.codeFileName === 'string' && !!job.codeFileName &&
    typeof job.code === 'string' && job.code.trim().length > 0;
}

/**
 * Accepts a job from a content script and persists it before anything else, so a worker shutdown mid-sync cannot lose it.
 * Returns the acknowledgement the content script turns into its immediate toast.
 */
export async function acceptSyncJob(job, originTabId) {
  if (!isValidJob(job)) return { accepted: false, reasonCode: 'INVALID_JOB', error: 'Malformed sync job.' };

  const auth = await chrome.storage.local.get(['tufhub_token', 'tufhub_hook']);
  if (!auth.tufhub_token || !auth.tufhub_hook) {
    await pushDiag('FAILED', 'AUTH_REQUIRED', 'No token or repo hook in storage.', job.url);
    await updateHealth({ lastFailureAt: Date.now(), lastFailureReason: 'AUTH_REQUIRED' });
    setBadge('error');
    return { accepted: false, reasonCode: 'AUTH_REQUIRED' };
  }

  const entry = {
    id: job.id,
    job: { ...job, originTabId: typeof originTabId === 'number' ? originTabId : null },
    attempts: 0,
    enqueuedAt: Date.now(),
    nextAttemptAt: 0
  };

  const outcome = await withQueueLock(async () => {
    const queue = await readQueue();
    const sameFile = it => it.job.folderPath === job.folderPath && it.job.codeFileName === job.codeFileName;
    if (queue.some(it => sameFile(it) && it.job.code === job.code)) return 'duplicate';
    // A newer submission of the same file supersedes older queued ones so only the latest code is committed; a job already running is left to finish.
    const kept = queue.filter(it => !sameFile(it) || it.id === runningJobId);
    kept.push(entry);
    await writeQueue(kept);
    return 'queued';
  });

  if (outcome === 'duplicate') return { accepted: true, duplicate: true, jobId: job.id };

  await pushDiag('SYNC_START', job.source || '', `${job.slug} -> ${job.folderPath}/${job.codeFileName}`, job.url);
  // Deferred to a new task so the acknowledgement reaches the tab before any status message from the drain.
  setTimeout(() => { drainSyncQueue(); }, 0);
  return { accepted: true, jobId: job.id };
}

// -------------------------------------------------------------
// Drain loop
// -------------------------------------------------------------

/**
 * Runs every due job, one at a time, through the shared GitHub write lock, then schedules the next retry.
 * Safe to call from any trigger (hand-off, alarm, worker start); overlapping calls collapse into one extra pass.
 */
export function drainSyncQueue() {
  if (drainPromise) {
    drainRequested = true;
    return drainPromise;
  }
  drainPromise = (async () => {
    try {
      do {
        drainRequested = false;
        await drainDueJobs();
      } while (drainRequested);
      await scheduleNextRetry();
    } catch (err) {
      console.error('[TUFHub Sync Queue] Drain failed:', err);
    } finally {
      drainPromise = null;
    }
  })();
  return drainPromise;
}

async function drainDueJobs() {
  for (;;) {
    const next = await withQueueLock(async () => {
      const now = Date.now();
      const due = (await readQueue()).filter(it => (it.nextAttemptAt || 0) <= now);
      due.sort((a, b) => (a.enqueuedAt || 0) - (b.enqueuedAt || 0));
      return due[0] || null;
    });
    if (!next) return;

    runningJobId = next.id;
    let outcome;
    if (Date.now() - (next.enqueuedAt || 0) > MAX_JOB_AGE_MS) {
      outcome = { ok: false, retryable: false, reasonCode: 'QUEUE_EXPIRED', message: 'Queued for over 24 hours without reaching GitHub.' };
    } else {
      try {
        outcome = await enqueueGitHubWrite(() => runSyncJob(next.job));
      } catch (err) {
        outcome = classifySyncError(err);
      }
    }
    await settleJob(next, outcome);
    runningJobId = '';
  }
}

async function settleJob(item, outcome) {
  const firstFailure = !item.lastReasonCode;
  // Offline failures are not the job's fault, so they do not spend its retry budget; MAX_JOB_AGE_MS bounds them instead.
  const attempts = outcome.reasonCode === 'NO_INTERNET' ? (item.attempts || 0) : (item.attempts || 0) + 1;
  const willRetry = !outcome.ok && outcome.retryable && attempts < MAX_ATTEMPTS;

  const stillQueued = await withQueueLock(async () => {
    const queue = await readQueue();
    const idx = queue.findIndex(it => it.id === item.id);
    if (idx === -1) return false;
    if (willRetry) {
      queue[idx] = { ...queue[idx], attempts, nextAttemptAt: Date.now() + retryDelayMs(attempts, outcome), lastReasonCode: outcome.reasonCode };
    } else {
      queue.splice(idx, 1);
    }
    await writeQueue(queue);
    return true;
  });

  // A job superseded by a newer submission of the same file while it ran has nothing left to retry, so only a final result is worth reporting.
  if (willRetry && !stillQueued) return;
  await reportOutcome(item.job, outcome, attempts, willRetry, firstFailure);
}

function retryDelayMs(attempts, outcome) {
  if (outcome.reasonCode === 'NO_INTERNET') return OFFLINE_RETRY_MS;
  const table = outcome.reasonCode === 'RATE_LIMITED' ? RATE_LIMIT_DELAYS_MS : RETRY_DELAYS_MS;
  return table[Math.min(Math.max(attempts, 1) - 1, table.length - 1)];
}

async function scheduleNextRetry() {
  const queue = await withQueueLock(readQueue);
  clearTimeout(retryTimer);
  retryTimer = null;
  try {
    if (queue.length === 0) {
      await chrome.alarms.clear(SYNC_RETRY_ALARM);
      return;
    }
    setBadge('queued', queue.length);
    const earliest = Math.min(...queue.map(it => it.nextAttemptAt || 0));
    const delay = Math.max(0, earliest - Date.now());
    retryTimer = setTimeout(() => {
      retryTimer = null;
      drainSyncQueue();
    }, delay);
    await chrome.alarms.create(SYNC_RETRY_ALARM, { when: Date.now() + Math.max(delay, MIN_ALARM_DELAY_MS) });
  } catch (err) {
    console.error('[TUFHub Sync Queue] Could not schedule retry:', err);
  }
}

// -------------------------------------------------------------
// Commit pipeline
// -------------------------------------------------------------

/**
 * Commits one job (code file, problem README when the job carries one, and the root index) as a single atomic commit.
 * NOTE: Runs inside the GitHub write lock, so the stats preview behind the root README always includes every commit that landed before it.
 * NOTE: Local stats and the code hash are written only after the commit lands, so a failed sync never claims progress GitHub does not have.
 */
async function runSyncJob(job) {
  try {
    const auth = await chrome.storage.local.get(['tufhub_token', 'tufhub_hook']);
    const token = auth.tufhub_token;
    const hook = auth.tufhub_hook;
    if (!token || !hook) return { ok: false, retryable: false, reasonCode: 'AUTH_REQUIRED', message: 'GitHub not connected.' };

    if (await isCodeIdentical(job.folderPath, job.codeFileName, job.code)) {
      return { ok: true, skipped: true, reasonCode: 'CODE_UNCHANGED' };
    }

    // Auto-reconcile local stats with GitHub repo state so deleted repo items are purged.
    const stats = (await scanAndSyncRepoStats(token, hook)) || (await getStats());
    const problemMeta = {
      title: job.title,
      codeFileName: job.codeFileName,
      fileLabel: job.fileLabel,
      folderPath: job.folderPath
    };
    // computeUpdatedStats and updateStats take (mainTopic, subTopic); the category needs no slot because it is already the first segment of folderPath.
    const previewStats = computeUpdatedStats(stats, job.difficulty, job.slug, {}, job.mainTopic, job.subTopic, problemMeta);
    const rootReadmeFile = await buildRootReadmeFile(token, hook, previewStats);

    const files = [{ path: `${job.folderPath}/${job.codeFileName}`, content: job.code }];
    if (job.readme) files.push({ path: `${job.folderPath}/README.md`, content: job.readme });
    if (rootReadmeFile) files.push(rootReadmeFile);

    const result = await commitFiles(token, hook, files, `Sync ${job.title} [${job.category}] (TUFHub)`);
    await updateCodeHash(job.folderPath, job.codeFileName, job.code);
    if (result.unchanged) return { ok: true, skipped: true, reasonCode: 'CODE_UNCHANGED' };

    await updateStats(job.difficulty, job.slug, {
      [job.codeFileName]: true,
      'README.md': true
    }, job.mainTopic, job.subTopic, problemMeta);
    return { ok: true, commitSha: result.commitSha || '', htmlUrl: result.htmlUrl || '' };
  } catch (err) {
    return classifySyncError(err);
  }
}

// Maps a pipeline error to a retry decision; HTTP statuses come from the "(NNN)" suffix every uploader error message carries.
function classifySyncError(err) {
  const message = err && err.message ? err.message : String(err);
  const statusMatch = message.match(/\((\d{3})\)/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (offline || /failed to fetch|fetch failed|networkerror|network error|load failed/i.test(message)) {
    return { ok: false, retryable: true, reasonCode: 'NO_INTERNET', message };
  }
  // Checked before the 422 rule because a ref conflict surfaces as HTTP 422 but clears once GitHub's branch state catches up.
  if (message.includes('Ref Update Conflict')) return { ok: false, retryable: true, reasonCode: 'GITHUB_SYNC_LAG', message };
  if (status === 401) return { ok: false, retryable: false, reasonCode: 'TOKEN_EXPIRED', message };
  if (status === 404) return { ok: false, retryable: false, reasonCode: 'REPO_NOT_FOUND', message };
  if (status === 403 || status === 429) return { ok: false, retryable: true, reasonCode: 'RATE_LIMITED', message };
  if (status === 422) return { ok: false, retryable: false, reasonCode: 'SYNC_ERROR', message };
  return { ok: false, retryable: true, reasonCode: 'SYNC_ERROR', message };
}

// -------------------------------------------------------------
// Status reporting
// -------------------------------------------------------------

// Status goes only to the tab that submitted the job; content.js then shows it only while that tab is still on the same problem.
function notifyOrigin(job, payload) {
  if (typeof job.originTabId !== 'number') return;
  try {
    chrome.tabs.sendMessage(job.originTabId, {
      type: 'TUFHUB_SYNC_STATUS',
      jobId: job.id,
      token: job.token || '',
      slug: job.slug,
      title: job.title,
      category: job.category,
      ...payload
    }, () => {
      // The originating tab may be closed or on a non-TUF page by now; the badge and Sync Health already carry the outcome.
      void chrome.runtime.lastError;
    });
  } catch (e) {}
}

async function reportOutcome(job, outcome, attempts, willRetry, firstFailure) {
  const path = `${job.folderPath}/${job.codeFileName}`;

  if (outcome.ok && outcome.skipped) {
    await pushDiag('SKIPPED', outcome.reasonCode || 'CODE_UNCHANGED', path, job.url);
    notifyOrigin(job, { state: 'skipped', reasonCode: outcome.reasonCode || 'CODE_UNCHANGED' });
    return;
  }

  if (outcome.ok) {
    await pushDiag('SYNC_OK', '', job.slug, job.url);
    await updateHealth({
      lastSyncAt: Date.now(),
      lastSyncSlug: job.slug,
      lastSyncPath: path,
      lastCommitSha: outcome.commitSha,
      lastCommitUrl: outcome.htmlUrl,
      lastFailureReason: ''
    });
    setBadge('success');
    notifyOrigin(job, { state: 'success', commitSha: outcome.commitSha, htmlUrl: outcome.htmlUrl });
    return;
  }

  await updateHealth({ lastFailureAt: Date.now(), lastFailureReason: `${outcome.reasonCode}: ${outcome.message || ''}` });

  if (willRetry) {
    await pushDiag('QUEUED', outcome.reasonCode, `${job.slug} (attempt ${attempts}): ${outcome.message || ''}`, job.url);
    notifyOrigin(job, { state: 'queued', reasonCode: outcome.reasonCode, attempts, firstFailure });
    return;
  }

  const finalCode = outcome.retryable ? 'QUEUE_GAVE_UP' : outcome.reasonCode;
  await pushDiag('FAILED', finalCode, `${job.slug}: ${outcome.message || ''}`, job.url);
  setBadge('error');
  notifyOrigin(job, { state: 'failed', reasonCode: finalCode, message: outcome.message || '', attempts });
}
