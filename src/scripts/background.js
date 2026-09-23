/**
 * TUFHub Background Service Worker (Manifest V3)
 * Author: Mohit Arora (@Arora-Sir)
 */

import { reconcileRepoFromTree } from './tuf/stats.js';
import { commitFiles, deleteFiles } from './tuf/uploader.js';
import { enqueueGitHubWrite } from './tuf/writeQueue.js';
import { acceptSyncJob, applyBadgeState, drainSyncQueue, SYNC_RETRY_ALARM } from './tuf/syncQueue.js';
import { TUF_CONTENT_SCRIPT_URL } from './util.js';

const DEFAULT_CLIENT_ID = ''; // User provides their own OAuth Client ID via the welcome page

// -------------------------------------------------------------
// Durable sync queue wake-ups
// -------------------------------------------------------------
// NOTE: Every worker start (browser launch, alarm, incoming message) resumes queued sync jobs, because MV3 can stop the worker between retries.
// NOTE: The alarm is the backstop for retries scheduled further out than the worker's idle lifetime.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === SYNC_RETRY_ALARM) drainSyncQueue();
});
drainSyncQueue();

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['tufhub_badge'], (res) => {
    if (res && res.tufhub_badge) {
      applyBadgeState(res.tufhub_badge);
    }
  });
  reinjectAllOpenTufTabs();
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    const welcomeUrl = chrome.runtime.getURL('welcome.html');
    chrome.tabs.create({ url: welcomeUrl, active: true });
  } else if (details.reason === 'update') {
    // NOTE: Declarative content scripts only match when a document initially loads.
    // Extension updates do not retroactively inject into already-open matching tabs.
    // Tabs opened before manifest changes would otherwise stay permanently scriptless.
    // This sweep proactively re-injects scripts into all matching open tabs.
    reinjectAllOpenTufTabs();
  }
});

// NOTE: Must stay in sync with manifest.json content_scripts[].matches.
// chrome.tabs.query url filter requires literal glob patterns rather than regex.
const TUF_CONTENT_SCRIPT_MATCH_PATTERNS = [
  'https://takeuforward.org/practice/*',
  'https://takeuforward.org/practice-test/*',
  'https://takeuforward.org/learning/*',
  'https://*.takeuforward.org/practice/*',
  'https://*.takeuforward.org/practice-test/*',
  'https://*.takeuforward.org/learning/*'
];

function reinjectAllOpenTufTabs() {
  try {
    chrome.tabs.query({ url: TUF_CONTENT_SCRIPT_MATCH_PATTERNS }, (tabs) => {
      (tabs || []).forEach((tab) => {
        if (tab.id) ensureScriptsInjected(tab.id, tab.url);
      });
    });
  } catch (e) {}
}

// -------------------------------------------------------------
// SPA re-injection guard: re-injects content scripts on Next.js client-side navigation.
// Listens to chrome.tabs.onUpdated to re-arm tabs without requiring extra webNavigation permissions.
// -------------------------------------------------------------
function isTufAppUrl(url) {
  return typeof url === 'string' && TUF_CONTENT_SCRIPT_URL.test(url);
}

function pingContentScript(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: 'TUFHUB_PING' }, (res) => {
        // lastError just means nothing is listening in that tab yet.
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

// In-flight per-tab lock prevents rapid bursts of Next.js history events from injecting duplicate scripts.
const injectionInFlight = new Set();

async function ensureScriptsInjected(tabId, url) {
  if (injectionInFlight.has(tabId)) return;
  injectionInFlight.add(tabId);
  try {
    const pong = await pingContentScript(tabId);
    const needsInterceptor = !pong || !pong.interceptor;
    const needsContent = !pong || !pong.alive;

    if (!needsInterceptor && !needsContent) return;

    // Both scripts self-guard against double initialization, making redundant injection a safe no-op.
    try {
      if (needsInterceptor) {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['scripts/tuf/interceptor.js'],
          world: 'MAIN'
        });
      }
      if (needsContent) {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['scripts/tuf/content.js']
        });
      }
      console.log('[TUFHub BG] Re-armed TUF+ scripts after navigation:', url);
    } catch (e) {
      // Tab closed, restricted page, or another navigation raced us.
    }
  } finally {
    injectionInFlight.delete(tabId);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || (tab && tab.url);
  if (!isTufAppUrl(url)) return;
  // changeInfo.url covers History API navigation, while status 'complete' covers full document loads.
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  ensureScriptsInjected(tabId, url);
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_STORAGE') {
    chrome.storage.local.get(request.keys, (res) => {
      sendResponse(res || {});
    });
    return true;
  }

  if (request.type === 'SET_STORAGE') {
    chrome.storage.local.set(request.data, () => {
      sendResponse({ status: 'ok' });
    });
    return true;
  }

  if (request.type === 'LAUNCH_GITHUB_OAUTH') {
    launchTabOAuthFlow(request.clientId, request.clientSecret)
      .then((data) => sendResponse({ success: true, ...data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open for async response
  }

  if (request.type === 'CLEAR_BADGE') {
    chrome.storage.local.remove(['tufhub_badge']);
    chrome.action.setBadgeText({ text: '' });
    sendResponse({ status: 'badge_cleared' });
    return true;
  }

  if (request.type === 'REINJECT_TAB_SCRIPTS') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs && tabs[0];
      if (tab && isTufAppUrl(tab.url || '')) {
        await ensureScriptsInjected(tab.id, tab.url);
        sendResponse({ status: 'reinjected' });
      } else {
        sendResponse({ status: 'no_tab' });
      }
    });
    return true; // Keep message channel open for async response
  }

  if (request.type === 'SYNC_JOB') {
    // NOTE: The worker owns every sync from here on (persist, commit, retry), so a content script never commits or replays anything itself.
    // NOTE: Retries run here with no page attached, which is what keeps a queued DSA sync from reading whichever TUF tab happens to be open.
    // NOTE: sender.tab.id is recorded so progress and results are reported only to the tab that submitted.
    acceptSyncJob(request.job, sender && sender.tab ? sender.tab.id : null)
      .then((ack) => sendResponse(ack))
      .catch((err) => sendResponse({ accepted: false, reasonCode: 'SYNC_ERROR', error: (err && err.message) ? err.message : String(err) }));
    return true; // Keep message channel open for async response
  }

  if (request.type === 'RECONCILE_REPO') {
    // NOTE: Runs in the background worker because closing the popup tears down in-flight requests.
    // Guarantees tree reads and root README updates complete atomically without leaving orphaned state.
    chrome.storage.local.get(['tufhub_token', 'tufhub_hook'], (res) => {
      enqueueGitHubWrite(() => reconcileRepoFromTree(res.tufhub_token, res.tufhub_hook))
        .then((result) => {
          // A cooldown response carries no duplicates/needsRepair (nothing was actually re-checked), so it must never overwrite the last real result still sitting in storage.
          if (result.reason !== 'cooldown') chrome.storage.local.set({ tufhub_last_reconcile_result: result });
          sendResponse(result);
        })
        .catch((err) => {
          const result = { ok: false, reason: 'error', message: err && err.message };
          chrome.storage.local.set({ tufhub_last_reconcile_result: result });
          sendResponse(result);
        });
    });
    return true; // Keep message channel open for async response
  }

  if (request.type === 'DELETE_REPO_FOLDER') {
    // NOTE: Runs in service worker to prevent an in-flight folder deletion from aborting on popup close.
    // Re-reconciles repository immediately with skipCooldown to return fresh state in the response.
    // Delete and reconcile execute as a single atomic queued unit against concurrent writers.
    chrome.storage.local.get(['tufhub_token', 'tufhub_hook'], (res) => {
      const token = res.tufhub_token;
      const hook = res.tufhub_hook;
      enqueueGitHubWrite(async () => {
        await deleteFiles(token, hook, request.paths, `Remove duplicate folder ${request.folderPath} (TUFHub)`);
        let result = await reconcileRepoFromTree(token, hook, { skipCooldown: true });
        // Retries once if the tree-read briefly lags the delete commit that just landed on GitHub.
        const stillThere = (result.duplicates || []).some(d =>
          (d.folders || []).some(f => f.folderPath === request.folderPath));
        if (stillThere) {
          await new Promise(r => setTimeout(r, 1500));
          result = await reconcileRepoFromTree(token, hook, { skipCooldown: true });
        }
        // Deterministic safeguard: deleteFiles confirms ref update landed, so strip deleted folder from duplicates regardless of tree lag.
        if (result.duplicates) {
          result = {
            ...result,
            duplicates: result.duplicates
              .map(d => ({ ...d, folders: (d.folders || []).filter(f => f.folderPath !== request.folderPath) }))
              .filter(d => (d.folders || []).length > 1)
          };
        }
        return result;
      })
        .then((result) => {
          chrome.storage.local.set({ tufhub_last_reconcile_result: result });
          sendResponse(result);
        })
        .catch((err) => {
          sendResponse({ ok: false, reason: 'error', message: err && err.message });
        });
    });
    return true; // Keep message channel open for async response
  }

  if (request.type === 'DELETE_ALL_DUPLICATE_FOLDERS') {
    // NOTE: Bulk deletes all non-newest duplicate folders across every slug in a single commit.
    // Collapsing multiple folder removals into one commit avoids back-to-back ref update conflicts.
    chrome.storage.local.get(['tufhub_token', 'tufhub_hook'], (res) => {
      const token = res.tufhub_token;
      const hook = res.tufhub_hook;
      const items = request.items || [];
      const deletedFolderPaths = items.map(item => item.folderPath);
      const allPaths = items.flatMap(item => item.paths || []);

      enqueueGitHubWrite(async () => {
        await deleteFiles(token, hook, allPaths, `Remove ${items.length} duplicate folder(s) (TUFHub)`);
        let result = await reconcileRepoFromTree(token, hook, { skipCooldown: true });
        // Retries once if the tree-read briefly lags the delete commit that just landed on GitHub.
        const stillThere = (result.duplicates || []).some(d =>
          (d.folders || []).some(f => deletedFolderPaths.includes(f.folderPath)));
        if (stillThere) {
          await new Promise(r => setTimeout(r, 1500));
          result = await reconcileRepoFromTree(token, hook, { skipCooldown: true });
        }
        // Deterministic safeguard: deleteFiles confirmed every path landed, so strip all deleted folders from returned duplicates.
        if (result.duplicates) {
          result = {
            ...result,
            duplicates: result.duplicates
              .map(d => ({ ...d, folders: (d.folders || []).filter(f => !deletedFolderPaths.includes(f.folderPath)) }))
              .filter(d => (d.folders || []).length > 1)
          };
        }
        return result;
      })
        .then((result) => {
          chrome.storage.local.set({ tufhub_last_reconcile_result: result });
          sendResponse(result);
        })
        .catch((err) => {
          sendResponse({ ok: false, reason: 'error', message: err && err.message });
        });
    });
    return true; // Keep message channel open for async response
  }

  if (request.type === 'REPAIR_PROBLEMS') {
    // NOTE: The fetch, DOM-parse, and README regeneration for each flagged problem already happened in popup.js (a real page with a real DOMParser; this service worker has none). This handler only commits the finished file contents, same division of labor as every other write path.
    chrome.storage.local.get(['tufhub_token', 'tufhub_hook'], (res) => {
      const token = res.tufhub_token;
      const hook = res.tufhub_hook;
      const files = request.files || [];
      if (files.length === 0) {
        sendResponse({ ok: false, reason: 'error', message: 'No repaired files to commit.' });
        return;
      }
      const repairedFolders = files.map(f => f.path.replace(/\/README\.md$/, ''));

      enqueueGitHubWrite(async () => {
        await commitFiles(token, hook, files, `Repair ${files.length} problem README(s): fix dead TUF links and regenerate content (TUFHub)`);
        let result = await reconcileRepoFromTree(token, hook, { skipCooldown: true });
        // Retries once if the tree-read briefly lags the commit that just landed on GitHub.
        const stillFlagged = (result.needsRepair || []).some(item => repairedFolders.includes(item.folderPath));
        if (stillFlagged) {
          await new Promise(r => setTimeout(r, 1500));
          result = await reconcileRepoFromTree(token, hook, { skipCooldown: true });
        }
        return result;
      })
        .then((result) => {
          chrome.storage.local.set({ tufhub_last_reconcile_result: result });
          sendResponse(result);
        })
        .catch((err) => {
          sendResponse({ ok: false, reason: 'error', message: err && err.message });
        });
    });
    return true; // Keep message channel open for async response
  }

  if (request.type === 'OPEN_POPUP') {
    chrome.storage.local.get(['tufhub_token'], (res) => {
      if (!res.tufhub_token) {
        chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
      }
    });
    sendResponse({ status: 'popup_triggered' });
    return true;
  }

  return true;
});

function launchTabOAuthFlow(customClientId, customClientSecret) {
  const clientId = customClientId || DEFAULT_CLIENT_ID;
  // Construct OAuth redirect URI using chrome.runtime.id (no identity permission needed)
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  const state = `tufhub_${Date.now()}`;
  const authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&scope=repo&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  return new Promise((resolve, reject) => {
    // Open OAuth in a dedicated tab (bypasses browser popup blocks)
    chrome.tabs.create({ url: authUrl, active: true }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        return reject(new Error('Failed to open OAuth tab'));
      }

      const authTabId = tab.id;

      // Listener for tab URL changes
      function tabUpdateListener(tabId, changeInfo, updatedTab) {
        if (tabId !== authTabId || !changeInfo.url) return;

        const url = changeInfo.url;
        // Check if redirect URI was reached with code or error parameter
        if (url.includes('code=') || url.includes('error=')) {
          chrome.tabs.onUpdated.removeListener(tabUpdateListener);
          
          try {
            const urlObj = new URL(url);
            const code = urlObj.searchParams.get('code');
            const error = urlObj.searchParams.get('error_description') || urlObj.searchParams.get('error');

            // Close the OAuth tab
            chrome.tabs.remove(authTabId).catch(() => {});

            if (error) {
              return reject(new Error(`GitHub Authorization Error: ${error}`));
            }

            if (!code) {
              return reject(new Error('No code parameter found in redirect URL.'));
            }

            // Exchange authorization code for token
            handleCodeExchange(code, clientId, customClientSecret)
              .then(async (result) => {
                await chrome.storage.local.set({
                  tufhub_token: result.token,
                  tufhub_username: result.username
                });
                resolve(result);
              })
              .catch(reject);

          } catch (e) {
            chrome.tabs.remove(authTabId).catch(() => {});
            reject(e);
          }
        }
      }

      chrome.tabs.onUpdated.addListener(tabUpdateListener);

      // Timeout after 60 seconds
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(tabUpdateListener);
        reject(new Error('OAuth authentication timed out (60s). Please try again or use Personal Access Token.'));
      }, 60000);
    });
  });
}

async function handleCodeExchange(code, clientId, clientSecret = '') {
  const bodyParams = new URLSearchParams({
    client_id: clientId,
    code: code
  });

  if (clientSecret) {
    bodyParams.append('client_secret', clientSecret);
  }

  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: bodyParams
  });

  const data = await res.json();

  if (data.error) {
    if (data.error === 'bad_verification_code') {
      throw new Error('Authorization code expired or already used. Please click Launch OAuth again.');
    }
    if (data.error === 'incorrect_client_credentials') {
      throw new Error('Client Secret is incorrect. Please check your GitHub Developer Settings.');
    }
    throw new Error(`GitHub OAuth Error: ${data.error_description || data.error}`);
  }

  if (!data.access_token) {
    throw new Error('No access_token field returned by GitHub OAuth API.');
  }

  // Fetch authenticated user profile
  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `token ${data.access_token}`,
      Accept: 'application/vnd.github.v3+json'
    }
  });

  if (!userRes.ok) {
    throw new Error(`Failed to verify GitHub token (HTTP ${userRes.status}).`);
  }

  const userData = await userRes.json();
  return { token: data.access_token, username: userData.login };
}
