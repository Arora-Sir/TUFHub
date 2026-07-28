/**
 * TUFHub Extension Popup Controller
 * Author: Mohit Arora (@Arora-Sir)
 */

document.addEventListener('DOMContentLoaded', () => {
  const unauthSection = document.getElementById('unauth-section');
  const authSection = document.getElementById('auth-section');
  const connectBtn = document.getElementById('connect-btn');
  const disconnectBtn = document.getElementById('disconnect-btn');
  const userHandle = document.getElementById('user-handle');
  const devProfileLink = document.getElementById('dev-profile-link');
  const repoLink = document.getElementById('repo-link');

  const statSolved = document.getElementById('stat-solved');
  const statEasy = document.getElementById('stat-easy');
  const statMedium = document.getElementById('stat-medium');
  const statHard = document.getElementById('stat-hard');

  const upiBtn = document.getElementById('upi-btn');
  const upiModal = document.getElementById('upi-modal');
  const copyUpiBtn = document.getElementById('copy-upi-btn');

  function renderStats(stats) {
    if (!stats) return;
    statSolved.innerText = stats.solved || 0;
    statEasy.innerText = stats.easy || 0;
    statMedium.innerText = stats.medium || 0;
    statHard.innerText = stats.hard || 0;
  }

  // Load state
  chrome.storage.local.get(['tufhub_token', 'tufhub_username', 'tufhub_hook', 'stats'], (res) => {
    if (res.tufhub_token && res.tufhub_hook) {
      unauthSection.classList.add('hidden');
      authSection.classList.remove('hidden');
      disconnectBtn.classList.remove('hidden');

      const handle = res.tufhub_username || 'Arora-Sir';
      userHandle.innerText = `@${handle}`;
      if (devProfileLink) {
        devProfileLink.href = `https://github.com/${handle}`;
      }
      repoLink.href = `https://github.com/${res.tufhub_hook}`;

      renderStats(res.stats);
    } else {
      unauthSection.classList.remove('hidden');
      authSection.classList.add('hidden');
      disconnectBtn.classList.add('hidden');
    }
  });

  // Real-time listener for stats updates in background/storage
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.stats) {
      renderStats(changes.stats.newValue);
    }
  });

  // Connect Button
  connectBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  });

  // Disconnect Button
  disconnectBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to disconnect TUFHub from GitHub?')) {
      chrome.storage.local.remove(['tufhub_token', 'tufhub_username', 'tufhub_hook', 'mode_type', 'stats'], () => {
        window.location.reload();
      });
    }
  });

  // UPI QR Code Modal Toggle
  upiBtn.addEventListener('click', () => {
    upiModal.classList.toggle('hidden');
  });

  // Copy UPI ID
  copyUpiBtn.addEventListener('click', () => {
    navigator.clipboard.writeText('mohit1998arora@yescred').then(() => {
      copyUpiBtn.innerText = 'Copied!';
      setTimeout(() => {
        copyUpiBtn.innerText = 'Copy';
      }, 2000);
    });
  });
});
