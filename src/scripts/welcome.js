/**
 * TUFHub Welcome/Onboarding Wizard
 * Author: Mohit Arora (@Arora-Sir)
 */

import { requestGitHubAuth } from './authorize.js';
import { scanAndSyncRepoStats } from './tuf/stats.js';

document.addEventListener('DOMContentLoaded', () => {
  const step1 = document.getElementById('step-1');
  const step2 = document.getElementById('step-2');
  const step3 = document.getElementById('step-3');

  const tabPat = document.getElementById('tab-pat');
  const tabOauth = document.getElementById('tab-oauth');
  const patBox = document.getElementById('pat-auth-box');
  const oauthBox = document.getElementById('oauth-auth-box');

  const patInput = document.getElementById('pat-input');
  const savePatBtn = document.getElementById('save-pat-btn');

  const clientIdInput = document.getElementById('client-id-input');
  const clientSecretInput = document.getElementById('client-secret-input');
  const authBtn = document.getElementById('auth-btn');

  const registerOauthLink = document.getElementById('register-oauth-link');
  const copyHomepageBtn = document.getElementById('copy-homepage-btn');
  const callbackUriText = document.getElementById('callback-uri-text');
  const copyCallbackBtn = document.getElementById('copy-callback-btn');

  const createRepoBtn = document.getElementById('create-repo-btn');
  const repoNameInput = document.getElementById('repo-name-input');
  const privateToggle = document.getElementById('private-toggle');
  const welcomeRepoLink = document.getElementById('welcome-repo-link');

  // Populate Chrome Identity Callback Redirect URI & Auto-Prefill OAuth Application Registration
  const redirectUri = chrome.identity ? chrome.identity.getRedirectURL() : 'https://<extension-id>.chromiumapp.org/';
  if (callbackUriText) {
    callbackUriText.innerText = redirectUri;
  }

  if (registerOauthLink) {
    const prefillUrl = `https://github.com/settings/applications/new?oauth_application[name]=TUFHub&oauth_application[url]=https://github.com/&oauth_application[callback_url]=${encodeURIComponent(redirectUri)}`;
    registerOauthLink.href = prefillUrl;
  }

  if (copyHomepageBtn) {
    copyHomepageBtn.addEventListener('click', () => {
      navigator.clipboard.writeText('https://github.com/').then(() => {
        copyHomepageBtn.innerText = 'Copied!';
        setTimeout(() => {
          copyHomepageBtn.innerText = 'Copy Homepage URL';
        }, 2000);
      });
    });
  }

  if (copyCallbackBtn) {
    copyCallbackBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(redirectUri).then(() => {
        copyCallbackBtn.innerText = 'Copied!';
        setTimeout(() => {
          copyCallbackBtn.innerText = 'Copy Callback URL';
        }, 2000);
      });
    });
  }

  // Tab switching
  tabPat.addEventListener('click', () => {
    tabPat.classList.add('active');
    tabOauth.classList.remove('active');
    patBox.classList.remove('hidden');
    oauthBox.classList.add('hidden');
  });

  tabOauth.addEventListener('click', () => {
    tabOauth.classList.add('active');
    tabPat.classList.remove('active');
    oauthBox.classList.remove('hidden');
    patBox.classList.add('hidden');
  });

  // Check initial state
  chrome.storage.local.get(['tufhub_token', 'tufhub_hook'], (res) => {
    if (res.tufhub_token && res.tufhub_hook) {
      step1.classList.add('hidden');
      step2.classList.add('hidden');
      step3.classList.remove('hidden');
      welcomeRepoLink.href = `https://github.com/${res.tufhub_hook}`;
    } else if (res.tufhub_token) {
      step1.classList.add('hidden');
      step2.classList.remove('hidden');
    }
  });

  // PAT Authentication Handler
  savePatBtn.addEventListener('click', async () => {
    const token = patInput.value.trim();
    if (!token) {
      alert('Please paste a valid GitHub Personal Access Token.');
      return;
    }

    try {
      savePatBtn.innerText = 'Validating Token...';
      savePatBtn.disabled = true;

      const res = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json'
        }
      });

      if (!res.ok) {
        throw new Error(`Invalid Token (HTTP ${res.status}). Check scope permissions.`);
      }

      const userData = await res.json();
      const username = userData.login;

      await chrome.storage.local.set({
        tufhub_token: token,
        tufhub_username: username
      });

      step1.classList.add('hidden');
      step2.classList.remove('hidden');
    } catch (err) {
      alert('Token Validation Failed: ' + err.message);
      savePatBtn.innerText = 'Save Token & Continue →';
      savePatBtn.disabled = false;
    }
  });

  // OAuth Authentication Handler
  authBtn.addEventListener('click', async () => {
    const customClientId = clientIdInput.value.trim();
    const customClientSecret = clientSecretInput.value.trim();

    try {
      authBtn.innerText = 'Launching OAuth...';
      authBtn.disabled = true;
      
      const res = await requestGitHubAuth(customClientId, customClientSecret);
      
      step1.classList.add('hidden');
      step2.classList.remove('hidden');
    } catch (err) {
      alert('GitHub Auth Failed: ' + err.message + '\n\nTip: You can also use the Personal Access Token tab for instant setup!');
      authBtn.innerText = 'Launch GitHub OAuth Flow';
      authBtn.disabled = false;
    }
  });

  // Step 2: Create Repo Handler
  createRepoBtn.addEventListener('click', async () => {
    const repoName = repoNameInput.value.trim() || 'TUF-Solutions';
    const isPrivate = privateToggle.checked;

    try {
      createRepoBtn.innerText = 'Creating Repository...';
      createRepoBtn.disabled = true;

      const { tufhub_token: token, tufhub_username: username } = await chrome.storage.local.get([
        'tufhub_token',
        'tufhub_username'
      ]);

      if (!token) throw new Error('Not authenticated');

      const response = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: repoName,
          private: isPrivate,
          description: 'A collection of TakeUForward (TUF+) solutions - Auto-synced with TUFHub',
          auto_init: true
        })
      });

      if (!response.ok && response.status !== 422) {
        throw new Error(`GitHub API Error: ${response.status}`);
      }

      const repoHook = `${username}/${repoName}`;
      await chrome.storage.local.set({
        tufhub_hook: repoHook,
        mode_type: 'commit'
      });

      // Auto-scan existing repo stats for previously solved problems
      await scanAndSyncRepoStats(token, repoHook);

      welcomeRepoLink.href = `https://github.com/${repoHook}`;
      step2.classList.add('hidden');
      step3.classList.remove('hidden');
    } catch (err) {
      alert('Failed to create repository: ' + err.message);
      createRepoBtn.innerText = 'Create Repository & Finish Setup →';
      createRepoBtn.disabled = false;
    }
  });
});
