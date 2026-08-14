/**
 * TUFHub Background Service Worker (Manifest V3)
 * Author: Mohit Arora (@Arora-Sir)
 */

import { reconcileRepoFromTree, isCodeIdentical, updateCodeHash } from './tuf/stats.js';
import { commitFiles, deleteFiles } from './tuf/uploader.js';

const DEFAULT_CLIENT_ID = ''; // User provides their own OAuth Client ID via the welcome page

// -------------------------------------------------------------
// GitHub write serialization queue
//
// All three flows that mutate the GitHub repo (auto-sync commitFiles, popup
// delete, popup reconcile) must never run concurrently - overlapping
// tree/commit/ref-PATCH sequences race GitHub's ref update even with
// commitTreeEntries' own retry loop, because both callers keep re-reading
// each other's just-moved HEAD. One FIFO promise chain forces every write
// flow to fully settle before the next one starts its own tree read,
// regardless of which tab/popup/handler triggered it.
//
// Lives in module scope, so it resets whenever the MV3 service worker is
// killed and restarted - that's correct, not a bug: a fresh scope means
// ghWriteQueue becomes a freshly-resolved promise, and nothing was
// genuinely in flight that survived the kill either (any pending fetch()
// died with the worker). Chrome also keeps the worker alive for the
// duration of a pending onMessage listener that hasn't called sendResponse
// yet, so a kill mid-write is rare; when it happens, the content script's
// sendMessage call rejects and becomes a normal thrown Error that the
// existing catch-block/offline-queue logic already handles unchanged.
let ghWriteQueue = Promise.resolve();

function enqueueGitHubWrite(taskFn) {
  const result = ghWriteQueue.then(taskFn, taskFn);
  ghWriteQueue = result.catch(() => {}); // never let a rejection poison the chain for the next caller
  return result;
}

function applyBadgeState(badgeData) {
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

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['tufhub_badge'], (res) => {
    if (res && res.tufhub_badge) {
      applyBadgeState(res.tufhub_badge);
    }
  });
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    const welcomeUrl = chrome.runtime.getURL('welcome.html');
    chrome.tabs.create({ url: welcomeUrl, active: true });
  }
});

// -------------------------------------------------------------
// SPA re-injection guard
//
// Chrome never re-injects declarative content scripts on Next.js History API
// navigation. If a tab starts on a URL outside the content-script match
// patterns (the site root, for example) and the user then routes into a problem
// entirely client-side, the tab has no interceptor at all and submissions sync
// silently fail until a hard refresh. This restores them without needing the
// webNavigation permission - chrome.tabs.onUpdated already reports SPA URL
// changes, and "tabs" + "scripting" are both already declared in the manifest.
// -------------------------------------------------------------
const TUF_PLUS_URL = /^https:\/\/(?:[a-z0-9-]+\.)*takeuforward\.org\/plus/i;

function isTufPlusUrl(url) {
  return typeof url === 'string' && TUF_PLUS_URL.test(url);
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

// Next.js fires several history-API events in a row for a single logical
// navigation (route change, then hydration, then a query-param update). Each
// one lands here as its own onUpdated call, and pingContentScript() is an
// async round-trip - without a lock, 3-4 of these overlapping calls all see
// "nothing responded yet" and each independently executeScript()s content.js,
// stacking duplicate listeners in the tab (confirmed via a real "GitHub Ref
// Update Conflict (422)" storm: one accepted-submission event fired 5 synced
// commits at once). One in-flight check per tab collapses that burst into a
// single ping+inject.
const injectionInFlight = new Set();

async function ensureScriptsInjected(tabId, url) {
  if (injectionInFlight.has(tabId)) return;
  injectionInFlight.add(tabId);
  try {
    const pong = await pingContentScript(tabId);
    const needsInterceptor = !pong || !pong.interceptor;
    const needsContent = !pong || !pong.alive;

    if (!needsInterceptor && !needsContent) return;

    // Both scripts self-guard against double initialization, so a redundant
    // injection is a no-op rather than a duplicate listener.
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
  if (!isTufPlusUrl(url)) return;
  // changeInfo.url covers History API navigation; status 'complete' covers a
  // full document load that raced the declarative injection.
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

  if (request.type === 'SET_BADGE' || request.type === 'SHOW_BADGE_SUCCESS') {
    const state = request.type === 'SHOW_BADGE_SUCCESS' ? 'success' : request.state;
    const count = request.count;
    const badgeData = { state, count };
    chrome.storage.local.set({ tufhub_badge: badgeData });
    applyBadgeState(badgeData);
    sendResponse({ status: 'badge_updated' });
    return true;
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
      if (tab && isTufPlusUrl(tab.url || '')) {
        await ensureScriptsInjected(tab.id, tab.url);
        sendResponse({ status: 'reinjected' });
      } else {
        sendResponse({ status: 'no_tab' });
      }
    });
    return true; // Keep message channel open for async response
  }

  if (request.type === 'GITHUB_COMMIT_FILES') {
    // token/hook read here, not trusted from the content script - same trust
    // boundary as RECONCILE_REPO/DELETE_REPO_FOLDER below. This is the
    // content-script auto-sync path (content.js's sendGitHubCommitMessage) -
    // routed through the service worker and the shared queue below instead of
    // calling commitFiles() directly in the tab's own realm, so it can never
    // race another tab's sync, a popup delete/reconcile, or its own
    // overlapping callers (interceptor event, DOM watcher, offline flush).
    chrome.storage.local.get(['tufhub_token', 'tufhub_hook'], (res) => {
      const token = res.tufhub_token;
      const hook = res.tufhub_hook;
      if (!token || !hook) {
        sendResponse({ success: false, error: 'GitHub not connected (missing token or hook).' });
        return;
      }
      const { slug, codeFileName, code } = request;
      enqueueGitHubWrite(async () => {
        // Re-checked here, not just in content.js: this task may have sat
        // behind another queued write that already synced this exact
        // slug+file while it waited. A fresh, atomic check right before
        // committing is what turns a would-be race into a clean skip instead
        // of a redundant commit.
        if (slug && codeFileName && await isCodeIdentical(slug, codeFileName, code)) {
          return { skipped: true };
        }
        const result = await commitFiles(token, hook, request.files, request.commitMessage);
        if (slug && codeFileName) await updateCodeHash(slug, codeFileName, code);
        return { skipped: false, ...result };
      })
        .then((result) => sendResponse({ success: true, ...result }))
        .catch((err) => sendResponse({ success: false, error: (err && err.message) ? err.message : String(err) }));
    });
    return true; // Keep message channel open for async response
  }

  if (request.type === 'RECONCILE_REPO') {
    // Runs here, not in the popup: a popup page is destroyed the instant it
    // closes, which would kill an in-flight fetch mid-operation - possibly
    // after the tree read but before the README write, leaving local stats
    // and the repo inconsistent. The service worker outlives the popup for
    // the duration of this handler.
    chrome.storage.local.get(['tufhub_token', 'tufhub_hook'], (res) => {
      enqueueGitHubWrite(() => reconcileRepoFromTree(res.tufhub_token, res.tufhub_hook))
        .then((result) => {
          chrome.storage.local.set({ tufhub_last_reconcile_result: result });
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
    // Same reasoning as RECONCILE_REPO above: runs in the service worker so a
    // closed popup can't leave a delete commit half-done. Re-reconciles right
    // after (skipCooldown - this is a system-triggered refresh reacting to a
    // real repo mutation, not the manual button-mashing the cooldown guards
    // against) so the response already reflects the post-delete repo state.
    // The whole delete-then-reconcile(-then-retry) sequence is one queued
    // unit, not two separate queue entries, since it's meant to be atomic
    // relative to other writers.
    chrome.storage.local.get(['tufhub_token', 'tufhub_hook'], (res) => {
      const token = res.tufhub_token;
      const hook = res.tufhub_hook;
      enqueueGitHubWrite(async () => {
        await deleteFiles(token, hook, request.paths, `Remove duplicate folder ${request.folderPath} - TUFHub`);
        let result = await reconcileRepoFromTree(token, hook, { skipCooldown: true });
        // GitHub's tree-read API can very briefly lag a commit that just
        // landed - if the folder we just deleted still shows up, the read
        // raced the write. One short retry improves general freshness, but
        // isn't relied on for correctness below - a fixed wait is never
        // actually guaranteed long enough under real contention.
        const stillThere = (result.duplicates || []).some(d =>
          (d.folders || []).some(f => f.folderPath === request.folderPath));
        if (stillThere) {
          await new Promise(r => setTimeout(r, 1500));
          result = await reconcileRepoFromTree(token, hook, { skipCooldown: true });
        }
        // Deterministic guarantee, independent of read timing: deleteFiles()
        // above only resolves once its own retry loop confirms the ref
        // update actually landed, so this path can never legitimately still
        // be a duplicate - strip it regardless of what the tree-read says.
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
  // Construct OAuth redirect URI using chrome.runtime.id - no identity permission needed
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
