/**
 * TUFHub Background Service Worker (Manifest V3)
 * Author: Mohit Arora (@Arora-Sir)
 */

const DEFAULT_CLIENT_ID = ''; // User provides their own OAuth Client ID via the welcome page

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

async function ensureScriptsInjected(tabId, url) {
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
