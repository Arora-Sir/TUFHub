/**
 * TUFHub Weekly Repo Health Check (background service worker only)
 * Scans the synced repo once a week, read-only, and flags duplicates, misplaced folders, and problems that need repair.
 * Fixing always stays a user click in the popup. This module never writes to GitHub.
 * Author: Mohit Arora (@Arora-Sir)
 */

import { reconcileRepoFromTree } from './stats.js';
import { enqueueGitHubWrite } from './writeQueue.js';

export const HEALTH_CHECK_ALARM = 'tufhub_health_check';
export const HEALTH_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
// The alarm only wakes the worker to ask "is a check due?", so a daily period keeps a week's due date accurate within a day.
const ALARM_PERIOD_MINUTES = 24 * 60;

let running = null;

// Unset means on. The check is read-only, and an opt-in default would never reach users who never open settings.
export function isHealthCheckEnabled(value) {
  return value !== false;
}

export function healthCheckDue(lastAt, now = Date.now()) {
  return !lastAt || now - lastAt >= HEALTH_CHECK_INTERVAL_MS;
}

// Issue count shown on the toolbar: duplicate groups plus problems listed under Needs repair.
export function healthIssueCount(result) {
  if (!result || result.ok === false) return 0;
  return (result.duplicates || []).length + (result.needsRepair || []).length;
}

export function ensureHealthCheckAlarm() {
  try {
    chrome.alarms.get(HEALTH_CHECK_ALARM, (alarm) => {
      if (!alarm) chrome.alarms.create(HEALTH_CHECK_ALARM, { delayInMinutes: 1, periodInMinutes: ALARM_PERIOD_MINUTES });
    });
  } catch (e) {}
}

/**
 * Runs the read-only check when it is enabled and due, or right away with force (the one-time check after an update).
 * Returns the summary it stored, or null when nothing ran.
 * NOTE: Goes through the GitHub write queue even though it only reads, so it never interleaves with a sync or repair commit and always sees a settled tree.
 * NOTE: Fire-and-forget from inside a queued task is safe, but awaiting it there would deadlock the FIFO lock.
 */
export async function runHealthCheckIfDue({ force = false, trigger = 'schedule' } = {}) {
  if (running) return running;
  running = (async () => {
    const res = await chrome.storage.local.get(['tufhub_token', 'tufhub_hook', 'tufhub_health_check_enabled', 'tufhub_health_check_last_at']);
    if (!res.tufhub_token || !res.tufhub_hook) return null;
    if (!isHealthCheckEnabled(res.tufhub_health_check_enabled)) return null;
    if (!force && !healthCheckDue(res.tufhub_health_check_last_at)) return null;

    const startedAt = Date.now();
    const result = await enqueueGitHubWrite(() => reconcileRepoFromTree(res.tufhub_token, res.tufhub_hook, { skipCooldown: true, dryRun: true }));
    const summary = {
      at: Date.now(),
      trigger,
      ok: !!(result && result.ok !== false),
      reason: result ? result.reason : 'error',
      duplicates: result && result.duplicates ? result.duplicates.length : 0,
      needsRepair: result && result.needsRepair ? result.needsRepair.length : 0,
      readmeOutdated: !!(result && result.readmeOutdated)
    };

    const writes = { tufhub_health_check_result: summary };
    if (summary.ok) {
      // A failed check (rate limit, network) keeps its due date, so the next wake-up retries instead of waiting a week.
      writes.tufhub_health_check_last_at = summary.at;
      writes.tufhub_last_reconcile_result = result;
      const count = healthIssueCount(result);
      const seen = await chrome.storage.local.get(['tufhub_health_seen_at']);
      // The popup opened while this check ran, so its panels already show these issues and the toolbar count would only nag.
      const seenDuringCheck = (seen.tufhub_health_seen_at || 0) >= startedAt;
      writes.tufhub_health_flag = count > 0 && !seenDuringCheck ? { count } : null;
    }
    await chrome.storage.local.set(writes);
    if (summary.ok) await showRestingBadge();
    return summary;
  })().finally(() => { running = null; });
  return running;
}

/**
 * Shows the health flag on the toolbar when no sync status badge is active.
 * NOTE: Sync states (queued, error) always win, because they need attention first. The flag returns once they clear.
 */
export async function showRestingBadge() {
  try {
    const res = await chrome.storage.local.get(['tufhub_badge', 'tufhub_health_flag']);
    const syncState = res.tufhub_badge && res.tufhub_badge.state;
    if (syncState === 'queued' || syncState === 'error') return;
    const flag = res.tufhub_health_flag;
    if (flag && flag.count > 0) {
      chrome.action.setBadgeText({ text: flag.count > 99 ? '99+' : String(flag.count) });
      chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) {}
}
