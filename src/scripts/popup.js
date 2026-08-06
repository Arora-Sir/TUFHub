import { scanAndSyncRepoStats } from './tuf/stats.js';

document.addEventListener('DOMContentLoaded', () => {
  // Clear toolbar badge when popup opens
  try {
    chrome.runtime.sendMessage({ type: 'CLEAR_BADGE' });
  } catch (e) {}

  const unauthSection = document.getElementById('unauth-section');
  const authSection = document.getElementById('auth-section');
  const connectBtn = document.getElementById('connect-btn');
  const disconnectBtn = document.getElementById('disconnect-btn');
  const userHandle = document.getElementById('user-handle');
  const devProfileLink = document.getElementById('dev-profile-link');
  const repoLink = document.getElementById('repo-link');
  const syncRepoBtn = document.getElementById('sync-repo-btn');

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
  chrome.storage.local.get(['tufhub_token', 'tufhub_username', 'tufhub_hook', 'stats'], async (res) => {
    if (res.tufhub_token && res.tufhub_hook) {
      unauthSection.classList.add('hidden');
      authSection.classList.remove('hidden');
      disconnectBtn.classList.remove('hidden');

      const handle = res.tufhub_username || 'User';
      userHandle.innerText = `@${handle}`;
      if (devProfileLink) {
        devProfileLink.href = `https://github.com/${handle}`;
      }
      repoLink.href = `https://github.com/${res.tufhub_hook}`;

      renderStats(res.stats);

      // Auto-sync existing repo stats if 0 solved or missing
      if (!res.stats || !res.stats.solved) {
        const updatedStats = await scanAndSyncRepoStats(res.tufhub_token, res.tufhub_hook);
        if (updatedStats) renderStats(updatedStats);
      }
    } else {
      unauthSection.classList.remove('hidden');
      authSection.classList.add('hidden');
      disconnectBtn.classList.add('hidden');
    }
  });

  // Manual Sync Repo Button Handler - reconciles against the actual repo tree
  // (adds/removes/renames included), not just a local-stats refresh.
  // Kept short and wrap-friendly on purpose - this button has a fixed width
  // (popup.css:#sync-repo-btn) so it can grow a line taller but never wider.
  const SYNC_REASON_LABELS = {
    cooldown: (r) => `Wait ${Math.ceil(r.remainingMs / 1000)}s`,
    unchanged: () => '✓ In sync',
    synced: (r) => (r.removedSlugs && r.removedSlugs.length) ? `✓ Synced (-${r.removedSlugs.length})` : '✓ Synced',
    rate_limited: () => 'Rate limited',
    auth: () => 'Reconnect',
    not_found: () => 'Repo not found',
    truncated: () => 'Too large',
    error: () => 'Sync failed'
  };

  if (syncRepoBtn) {
    syncRepoBtn.addEventListener('click', () => {
      syncRepoBtn.innerText = '⏳';
      syncRepoBtn.disabled = true;

      chrome.runtime.sendMessage({ type: 'RECONCILE_REPO' }, (result) => {
        const r = result || { reason: 'error' };
        if (r.stats) renderStats(r.stats);

        const label = (SYNC_REASON_LABELS[r.reason] || SYNC_REASON_LABELS.error)(r);
        syncRepoBtn.innerText = label;

        // Cooldown is informational, not an error state - no extended hold.
        const holdMs = r.reason === 'cooldown' ? 1500 : 2500;
        setTimeout(() => {
          syncRepoBtn.innerText = '↻ Sync';
          syncRepoBtn.disabled = false;
        }, holdMs);
      });
    });
  }

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

  // -------------------------------------------------------------
  // Sync Health panel
  //
  // Every way a sync can silently abort now writes a reason code to
  // tufhub_diag, so a failure can be diagnosed from here instead of needing
  // DevTools open on the TUF+ tab at the moment it happens.
  // -------------------------------------------------------------
  const TUF_PLUS_URL = /^https:\/\/(?:[a-z0-9-]+\.)*takeuforward\.org\/plus/i;

  const healthDot = document.getElementById('health-dot');
  const healthBody = document.getElementById('health-body');
  const healthSummary = document.getElementById('health-summary');
  const copyDiagBtn = document.getElementById('copy-diag-btn');
  const staleBanner = document.getElementById('stale-build-banner');

  function timeAgo(ts) {
    if (!ts) return 'never';
    const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
    return `${Math.round(secs / 86400)}d ago`;
  }

  function row(label, value, tone) {
    const color = tone === 'bad' ? '#ef4444' : (tone === 'good' ? '#22c55e' : (tone === 'amber' ? '#f59e0b' : 'inherit'));
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display: flex; gap: 8px; justify-content: space-between; align-items: center; min-width: 0;';

    const l = document.createElement('span');
    l.style.cssText = 'opacity: 0.65; flex: 0 0 auto;';
    l.textContent = label;

    const v = document.createElement('span');
    v.style.cssText = `text-align: right; color: ${color}; min-width: 0; overflow-wrap: anywhere; word-break: break-word;`;
    if (typeof value === 'string' && value.includes('<a ')) {
      v.innerHTML = value;
    } else {
      v.textContent = value;
    }

    wrap.appendChild(l);
    wrap.appendChild(v);
    return wrap;
  }

  function pingActiveTab() {
    return new Promise((resolve) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tab = tabs && tabs[0];
          if (!tab || !TUF_PLUS_URL.test(tab.url || '')) {
            return resolve({ state: 'no-tab' });
          }
          chrome.tabs.sendMessage(tab.id, { type: 'TUFHUB_PING' }, (res) => {
            if (chrome.runtime.lastError || !res || !res.alive) {
              // Attempt automatic re-injection for orphaned tab script
              chrome.runtime.sendMessage({ type: 'REINJECT_TAB_SCRIPTS' }, () => {
                setTimeout(() => {
                  chrome.tabs.sendMessage(tab.id, { type: 'TUFHUB_PING' }, (secondRes) => {
                    if (chrome.runtime.lastError || !secondRes || !secondRes.alive) {
                      return resolve({ state: 'not-hooked' });
                    }
                    if (!secondRes.interceptor) {
                      return resolve({ state: 'partial', version: secondRes.version });
                    }
                    resolve({ state: 'hooked', version: secondRes.version, interceptor: secondRes.interceptor });
                  });
                }, 150);
              });
              return;
            }
            if (!res.interceptor) {
              return resolve({ state: 'partial', version: res.version });
            }
            resolve({ state: 'hooked', version: res.version, interceptor: res.interceptor });
          });
        });
      } catch (e) {
        resolve({ state: 'not-hooked' });
      }
    });
  }

  async function checkStaleBuild() {
    if (!staleBanner) return;
    try {
      const loadedVer = chrome.runtime.getManifest().version;
      const manifestUrl = chrome.runtime.getURL('manifest.json');
      const diskRes = await fetch(manifestUrl);
      if (diskRes.ok) {
        const diskJson = await diskRes.json();
        const onDiskVer = diskJson.version || loadedVer;
        if (onDiskVer !== loadedVer) {
          staleBanner.textContent = `Rebuilt to v${onDiskVer} but v${loadedVer} is running - press Reload at chrome://extensions, then reload your TUF+ tab.`;
          staleBanner.classList.remove('hidden');
          return;
        }
      }
    } catch (e) {}
    staleBanner.classList.add('hidden');
  }

  const healthDetails = document.getElementById('health-details');
  const toggleDetailsBtn = document.getElementById('toggle-details-btn');

  if (toggleDetailsBtn && healthDetails) {
    toggleDetailsBtn.addEventListener('click', () => {
      const isHidden = healthDetails.classList.contains('hidden');
      if (isHidden) {
        healthDetails.classList.remove('hidden');
        toggleDetailsBtn.innerText = 'Hide details';
      } else {
        healthDetails.classList.add('hidden');
        toggleDetailsBtn.innerText = 'Show details';
      }
    });
  }

  async function renderHealth() {
    if (!healthBody) return;

    await checkStaleBuild();

    const res = await chrome.storage.local.get(['tufhub_health', 'tufhub_diag']);
    const health = res.tufhub_health || {};
    const diag = Array.isArray(res.tufhub_diag) ? res.tufhub_diag : [];
    const probe = await pingActiveTab();

    const lastRecentActivity = Math.max(health.lastSyncAt || 0, health.lastInitAt || 0);
    const TEN_MINS_MS = 10 * 60 * 1000;
    const isRecentlyActive = lastRecentActivity > 0 && (Date.now() - lastRecentActivity) < TEN_MINS_MS;

    let tabLabel = 'No TUF+ tab active';
    let tone = 'neutral';
    let dot = '#6b7280';

    if (probe.state === 'hooked') {
      tabLabel = `Hooked (v${probe.version})`;
      tone = 'good';
      dot = '#22c55e';
    } else if (probe.state === 'partial') {
      tabLabel = 'Messaging check failed';
      if (isRecentlyActive) {
        tone = 'amber';
        dot = '#f59e0b';
      } else {
        tone = 'bad';
        dot = '#ef4444';
      }
    } else if (probe.state === 'not-hooked') {
      tabLabel = 'Messaging check failed';
      if (isRecentlyActive) {
        tone = 'amber';
        dot = '#f59e0b';
      } else {
        tone = 'bad';
        dot = '#ef4444';
      }
    }

    if (healthDot) healthDot.style.background = dot;
    if (healthSummary) {
      if (probe.state === 'hooked') {
        healthSummary.textContent = 'Active';
      } else if (probe.state === 'no-tab') {
        healthSummary.textContent = 'Idle';
      } else if (isRecentlyActive) {
        healthSummary.textContent = 'Can\'t verify live, but recently active';
      } else {
        healthSummary.textContent = 'Needs attention';
      }
    }

    healthBody.replaceChildren();

    let lastSyncVal = 'no syncs recorded by this build';
    if (health.lastSyncAt) {
      const ago = timeAgo(health.lastSyncAt);
      if (health.lastCommitUrl) {
        const shaLabel = health.lastCommitSha ? `(${health.lastCommitSha.slice(0, 7)}) ` : '';
        lastSyncVal = `<a href="${health.lastCommitUrl}" target="_blank" rel="noopener noreferrer" style="color: #3b82f6; text-decoration: underline;">${shaLabel}${ago} ↗</a>`;
      } else {
        lastSyncVal = ago;
      }
    }
    healthBody.appendChild(row('Last successful sync', lastSyncVal, health.lastSyncAt ? 'good' : 'neutral'));

    if (health.lastFailureReason) {
      healthBody.appendChild(row('Last failure', `${health.lastFailureReason}`.slice(0, 60), 'bad'));
      healthBody.appendChild(row('Failed', timeAgo(health.lastFailureAt), 'bad'));
    }

    if (healthDetails) {
      healthDetails.replaceChildren();
      healthDetails.appendChild(row('Active tab', tabLabel, tone));
      healthDetails.appendChild(row('Extension', `v${chrome.runtime.getManifest().version}`, 'neutral'));
      healthDetails.appendChild(row('Diagnostic events', String(diag.length), 'neutral'));
    }
  }

  if (copyDiagBtn) {
    copyDiagBtn.addEventListener('click', async () => {
      const res = await chrome.storage.local.get(['tufhub_health', 'tufhub_diag', 'tufhub_hook']);
      const diag = Array.isArray(res.tufhub_diag) ? res.tufhub_diag : [];
      const lines = [
        `TUFHub v${chrome.runtime.getManifest().version}`,
        `UA: ${navigator.userAgent}`,
        `Repo: ${res.tufhub_hook || '(not set)'}`,
        `Health: ${JSON.stringify(res.tufhub_health || {})}`,
        '--- events (oldest first) ---',
        ...diag.map(d => `${new Date(d.ts).toISOString()} [${d.stage}] ${d.reasonCode} ${d.detail} ${d.url || ''}`.trim())
      ];
      await navigator.clipboard.writeText(lines.join('\n'));
      copyDiagBtn.innerText = 'Copied!';
      setTimeout(() => { copyDiagBtn.innerText = 'Copy Diagnostics'; }, 2000);
    });
  }

  renderHealth();
});
