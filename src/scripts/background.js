/**
 * TUFHub Background Service Worker (Manifest V3)
 * Author: Mohit Arora (@Arora-Sir)
 */

const DEFAULT_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    const welcomeUrl = chrome.runtime.getURL('welcome.html');
    chrome.tabs.create({ url: welcomeUrl, active: true });
  }
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

  if (request.type === 'SHOW_BADGE_SUCCESS') {
    chrome.action.setBadgeText({ text: 'OK' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '' });
    }, 5000);
    sendResponse({ status: 'badge_updated' });
    return true;
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
  const redirectUri = chrome.identity.getRedirectURL();
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
