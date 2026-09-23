import { scanAndSyncRepoStats } from './tuf/stats.js';
import { TUF_CONTENT_SCRIPT_URL } from './util.js';

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

  const upiBtn = document.getElementById('donate-btn');
  const upiModal = document.getElementById('upi-modal');
  const copyUpiBtn = document.getElementById('copy-upi-btn');
  const starRepoBtn = document.getElementById('star-repo-btn');

  function renderStats(stats) {
    if (!stats) return;
    statSolved.innerText = stats.solved || 0;
    statEasy.innerText = stats.easy || 0;
    statMedium.innerText = stats.medium || 0;
    statHard.innerText = stats.hard || 0;
  }

  // -------------------------------------------------------------
  // Duplicate problem folders panel
  // NOTE: Surfaces duplicate repo folders left behind after problem re-categorization.
  // Persists duplicate results in storage so warnings remain visible across popup sessions.
  // -------------------------------------------------------------
  const duplicatesSection = document.getElementById('duplicates-section');
  const duplicatesSummary = document.getElementById('duplicates-summary');
  const duplicatesBody = document.getElementById('duplicates-body');
  const copyDuplicatesBtn = document.getElementById('copy-duplicates-btn');
  const deleteAllDuplicatesBtn = document.getElementById('delete-all-duplicates-btn');

  let repoHook = ''; // set once auth state loads below, reused in the delete confirm dialog

  // Sorts folders newest first so star indicators match the version preserved during bulk deletion.
  // NOTE: Newer copies reflect current categorization, while older copies predate topic fixes.
  // NOTE: Null timestamps sort last so lookup errors are never mistaken for the oldest commit.
  function sortNewestFirst(folders) {
    return (folders || []).slice().sort((a, b) => {
      if (a.lastModified == null) return 1;
      if (b.lastModified == null) return -1;
      return b.lastModified - a.lastModified;
    });
  }

  // Names the solution files that exist only in this folder, so a duplicate cleanup never drops a solution the other copies lack without saying so.
  function filesOnlyIn(folder, otherFolders) {
    const nameOf = path => path.split('/').pop();
    const elsewhere = new Set(otherFolders.flatMap(f => (f.files || []).map(nameOf)));
    return (folder.files || []).map(nameOf).filter(name => name !== 'README.md' && !elsewhere.has(name));
  }

  function renderDuplicates(duplicates) {
    if (!duplicatesSection || !duplicatesBody) return;

    if (!duplicates || !duplicates.length) {
      duplicatesSection.classList.add('hidden');
      duplicatesBody.replaceChildren();
      return;
    }

    duplicatesSection.classList.remove('hidden');
    if (duplicatesSummary) {
      duplicatesSummary.textContent = `${duplicates.length} problem${duplicates.length > 1 ? 's' : ''}`;
    }

    duplicatesBody.replaceChildren();
    duplicates.forEach(({ slug, folders }) => {
      const entry = document.createElement('div');
      entry.style.cssText = 'margin-bottom: 10px;';

      const title = document.createElement('div');
      title.style.cssText = 'font-weight: 600; margin-bottom: 3px;';
      title.textContent = slug;
      entry.appendChild(title);

      // Newest commit first: the newer folder reflects current categorization, while older copies predate it.
      const sortedFolders = sortNewestFirst(folders);

      sortedFolders.forEach(({ folderPath, files, lastModified }, i) => {
        const pathRow = document.createElement('div');
        pathRow.style.cssText = 'display: flex; gap: 6px; align-items: center; padding-left: 6px; margin-top: 2px;';

        const pathLine = document.createElement('span');
        const isNewest = i === 0 && lastModified != null;
        pathLine.style.cssText = `flex: 1; min-width: 0; overflow-wrap: anywhere; word-break: break-word; ${isNewest ? 'color: #22c55e;' : 'opacity: 0.8;'}`;
        let label = `• ${folderPath}`;
        if (folderPath.includes('/General/')) label += ' (old default bucket)';
        if (lastModified != null) label += ` (${timeAgo(lastModified)})`;
        if (isNewest) label += ' ★ newest';
        pathLine.textContent = label;
        pathRow.appendChild(pathLine);

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'profile-cta danger-btn';
        deleteBtn.style.cssText = 'flex: 0 0 auto; padding: 2px 8px; font-size: 10px;';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', () => {
          const onlyHere = filesOnlyIn({ files }, sortedFolders.filter(f => f.folderPath !== folderPath));
          const uniqueNote = onlyHere.length ? `\n\nOnly in this folder (not in the other copies): ${onlyHere.join(', ')}` : '';
          const ok = confirm(`Delete "${folderPath}" and all its files from ${repoHook || 'your repo'}?${uniqueNote}\n\nThis cannot be undone.`);
          if (!ok) return;

          deleteBtn.disabled = true;
          deleteBtn.textContent = 'Deleting...';

          chrome.runtime.sendMessage({ type: 'DELETE_REPO_FOLDER', folderPath, paths: files }, (result) => {
            const r = result || { reason: 'error' };
            if (r.ok === false) {
              deleteBtn.disabled = false;
              deleteBtn.textContent = 'Delete failed: retry';
              return;
            }
            if (r.stats) renderStats(r.stats);
            // Re-renders from the post-delete result so resolved duplicate rows disappear immediately.
            renderDuplicates(r.duplicates);
          });
        });
        pathRow.appendChild(deleteBtn);

        entry.appendChild(pathRow);
      });

      duplicatesBody.appendChild(entry);
    });

    const hint = document.createElement('div');
    hint.style.cssText = 'margin-top: 4px; padding-top: 6px; border-top: 1px dashed rgba(255, 255, 255, 0.1); opacity: 0.65;';
    hint.textContent = 'Newest copy (green, ★) is usually the correct one to keep; delete the rest.';
    duplicatesBody.appendChild(hint);
  }

  if (copyDuplicatesBtn) {
    copyDuplicatesBtn.addEventListener('click', async () => {
      const res = await chrome.storage.local.get(['tufhub_last_reconcile_result']);
      const duplicates = (res.tufhub_last_reconcile_result && res.tufhub_last_reconcile_result.duplicates) || [];
      const lines = duplicates.flatMap(({ slug, folders }) => [
        slug,
        ...(folders || []).map(({ folderPath }) => `  git rm -r "${folderPath}"`)
      ]);
      await navigator.clipboard.writeText(lines.join('\n'));
      copyDuplicatesBtn.innerText = 'Copied!';
      setTimeout(() => { copyDuplicatesBtn.innerText = 'Copy list'; }, 2000);
    });
  }

  // NOTE: Removes all non-newest duplicate folders across every slug in a single atomic commit.
  // Avoids rapid sequential commit ref-update conflicts on GitHub.
  if (deleteAllDuplicatesBtn) {
    deleteAllDuplicatesBtn.addEventListener('click', async () => {
      const res = await chrome.storage.local.get(['tufhub_last_reconcile_result']);
      const duplicates = (res.tufhub_last_reconcile_result && res.tufhub_last_reconcile_result.duplicates) || [];

      const toDelete = duplicates.flatMap(({ folders }) => sortNewestFirst(folders).slice(1));
      if (toDelete.length === 0) return;

      const confirmLines = duplicates.flatMap(({ slug, folders }) => {
        const sorted = sortNewestFirst(folders);
        const stale = sorted.slice(1);
        return stale.length ? [slug, ...stale.map(f => {
          const onlyHere = filesOnlyIn(f, [sorted[0]]);
          return `  - ${f.folderPath}${onlyHere.length ? ` (only here: ${onlyHere.join(', ')})` : ''}`;
        })] : [];
      });
      const ok = confirm(
        `Delete ${toDelete.length} duplicate folder${toDelete.length > 1 ? 's' : ''} from ${repoHook || 'your repo'} in one commit? The newest (★) copy of each is kept.\n\nThis cannot be undone.\n\n${confirmLines.join('\n')}`
      );
      if (!ok) return;

      deleteAllDuplicatesBtn.disabled = true;
      deleteAllDuplicatesBtn.textContent = 'Deleting...';

      const items = toDelete.map(({ folderPath, files }) => ({ folderPath, paths: files }));
      chrome.runtime.sendMessage({ type: 'DELETE_ALL_DUPLICATE_FOLDERS', items }, (result) => {
        const r = result || { reason: 'error' };
        deleteAllDuplicatesBtn.disabled = false;
        deleteAllDuplicatesBtn.textContent = 'Delete all duplicates';
        if (r.ok === false) {
          deleteAllDuplicatesBtn.textContent = 'Delete failed: retry';
          return;
        }
        if (r.stats) renderStats(r.stats);
        renderDuplicates(r.duplicates);
      });
    });
  }

  // Milestone Nudge Banner
  // NOTE: Evaluated once per popup session rather than subscribing to live chrome.storage.onChanged events.
  // NOTE: Avoiding live storage subscriptions prevents sudden layout shifts while the user interacts with Sync or Duplicates.
  // NOTE: tufhub_milestone_last_shown tracks a monotonic watermark representing the highest milestone displayed to the user.
  // NOTE: Writing the watermark at display time ensures subsequent drops in stats.solved cannot trigger duplicate milestone alerts.
  // NOTE: A drop in stats.solved, for example from DELETE_ALL_DUPLICATE_FOLDERS or a Sync reconciliation that finds fewer live problems, can never re-arm a milestone the watermark already recorded.
  // NOTE: The banner text displays the live stats.solved count to maintain visual consistency with the header counter.
  // NOTE: Dismissing the banner only hides it for the current session without permanently opting out of future milestones.
  // NOTE: An earlier version set a permanent opt-out flag on dismiss instead, leaving no way back except clearing storage in DevTools; that is why dismiss now only hides the banner.
  const milestoneBanner = document.getElementById('milestone-banner');
  const milestoneBannerText = document.getElementById('milestone-banner-text');
  const milestoneCloseBtn = document.getElementById('milestone-close-btn');

  function computeMilestone(solved) {
    const n = Number(solved) || 0;
    return n >= 10 ? Math.floor(n / 10) * 10 : 0;
  }

  async function checkMilestoneNudge(stats) {
    if (!milestoneBanner || !milestoneBannerText) return;
    try {
      const solved = (stats && stats.solved) || 0;
      const milestone = computeMilestone(solved);
      if (!milestone) return;

      const store = await chrome.storage.local.get(['tufhub_milestone_opt_out', 'tufhub_milestone_last_shown', 'tufhub_starred_clicked']);
      if (store.tufhub_milestone_opt_out) return;

      const lastShown = store.tufhub_milestone_last_shown || 0;
      if (milestone <= lastShown) return;

      milestoneBannerText.textContent = store.tufhub_starred_clicked
        ? `🎉 ${solved} problems synced. Always free. The TUF+ link below helps a lot too.`
        : `🎉 ${solved} problems synced. Always free. A star or the TUF+ link below helps a lot.`;
      milestoneBanner.classList.remove('hidden');

      // Persisted immediately so this exact milestone watermark never displays a second time.
      await chrome.storage.local.set({ tufhub_milestone_last_shown: milestone });
    } catch (e) {
      milestoneBanner.classList.add('hidden');
    }
  }

  if (milestoneCloseBtn) {
    milestoneCloseBtn.addEventListener('click', () => {
      milestoneBanner.classList.add('hidden');
    });
  }

  // Load state
  chrome.storage.local.get(['tufhub_token', 'tufhub_username', 'tufhub_hook', 'stats', 'tufhub_last_reconcile_result'], async (res) => {
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
      repoHook = res.tufhub_hook;

      renderStats(res.stats);
      renderDuplicates(res.tufhub_last_reconcile_result && res.tufhub_last_reconcile_result.duplicates);

      let latestStats = res.stats;
      // Auto-sync existing repo stats if 0 solved or missing
      if (!res.stats || !res.stats.solved) {
        const updatedStats = await scanAndSyncRepoStats(res.tufhub_token, res.tufhub_hook);
        if (updatedStats) {
          renderStats(updatedStats);
          latestStats = updatedStats;
        }
      }

      checkMilestoneNudge(latestStats);
    } else {
      unauthSection.classList.remove('hidden');
      authSection.classList.add('hidden');
      disconnectBtn.classList.add('hidden');
      if (milestoneBanner) milestoneBanner.classList.add('hidden');
    }
  });

  // Tracks local click confirmation for the repository star button to avoid redundant prompts in the milestone banner.
  // Stored locally without remote GitHub API validation to avoid unnecessary network latency during popup initialization.
  if (starRepoBtn) {
    starRepoBtn.addEventListener('click', () => {
      try {
        chrome.storage.local.set({ tufhub_starred_clicked: true });
      } catch (e) {}
    });
  }

  // Manual Sync Repo: reconciles local state against the GitHub repo tree (additions, removals, renames).
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
        renderDuplicates(r.duplicates);

        const label = (SYNC_REASON_LABELS[r.reason] || SYNC_REASON_LABELS.error)(r);
        syncRepoBtn.innerText = label;

        // Cooldown is informational, not an error state: no extended hold.
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
      chrome.storage.local.remove(['tufhub_token', 'tufhub_username', 'tufhub_hook', 'mode_type', 'stats', 'tufhub_milestone_last_shown'], () => {
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
  // Sync Health panel: displays diagnostics and liveness probes to inspect sync failures without DevTools.
  // -------------------------------------------------------------
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
          if (!tab || !TUF_CONTENT_SCRIPT_URL.test(tab.url || '')) {
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
          staleBanner.textContent = `Rebuilt to v${onDiskVer} but v${loadedVer} is running, press Reload at chrome://extensions, then reload your TUF+ tab.`;
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
