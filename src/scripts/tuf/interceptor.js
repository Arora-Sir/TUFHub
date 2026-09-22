/**
 * TUFHub Page Interceptor (MAIN World)
 * Intent-gated payload matcher with a self-healing fetch/XHR hook.
 * Author: Mohit Arora (@Arora-Sir)
 */




(function () {
  if (window.__TUFHUB_INTERCEPTOR_INITED__) return;
  window.__TUFHUB_INTERCEPTOR_INITED__ = true;

  const TUFHUB_VERSION = process.env.TUFHUB_VERSION || '0.0.0';

  // Safety cap: keeps the submission gate open until a verdict arrives, navigation occurs, or timeout trips.
  // Extended 10-minute window accommodates cold judge environments without dropping verdicts.
  const ARM_MAX_AGE_MS = 10 * 60 * 1000;
  const ARM_KEY = '__tufhub_arm_state__';

  console.log(`%c[TUFHub Interceptor v${TUFHUB_VERSION}] 🚀 MAIN world fetch/XHR hook active.`, 'color: #22c55e; font-weight: bold; font-size: 13px;');

  // Liveness marker on documentElement readable from isolated world content scripts across re-renders.
  function markAlive() {
    try {
      if (document.documentElement.getAttribute('data-tufhub-interceptor') !== TUFHUB_VERSION) {
        document.documentElement.setAttribute('data-tufhub-interceptor', TUFHUB_VERSION);
      }
    } catch (e) {}
  }
  markAlive();

  let cachedProblemDescription = '';
  let cachedProblemDescriptionSlug = '';
  let cachedProblemTitle = '';
  let cachedProblemSlug = '';
  let lastProcessedSubmissionId = '';

  function currentProblemSlug() {
    try {
      const parts = window.location.pathname.split('/').filter(Boolean);
      return parts[parts.length - 1] || '';
    } catch (e) {
      return '';
    }
  }

  // Fallback title derived from URL slug when no h1 exists on the page (such as the Solution tab).
  function titleFromSlug(slug) {
    if (!slug) return '';
    return slug
      .split('-')
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  /**
   * Identifies the active editor tab using ARIA tab semantics (role="tab" and aria-selected).
   * Strips the close button subtree to isolate the clean tab display name.
   * Returns { label: '', count: 0 } on failure so callers degrade gracefully to solution.<ext>.
   */
  function getActiveTabInfo() {
    try {
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'))
        .filter(t => t.querySelector('button[aria-label^="Close "]'));
      if (tabs.length === 0) return { label: '', count: 0 };

      const labelOf = (tab) => {
        const contentDiv = tab.children[1] || tab;
        const clone = contentDiv.cloneNode(true);
        clone.querySelectorAll('button').forEach(b => b.remove());
        return clone.textContent.trim();
      };

      const active = tabs.find(t => t.getAttribute('aria-selected') === 'true');
      const label = labelOf(active || tabs[0]);
      return label ? { label, count: tabs.length } : { label: '', count: 0 };
    } catch (e) {
      return { label: '', count: 0 };
    }
  }

  function diag(stage, reasonCode, detail, persist = true) {
    try {
      console.log(`[TUFHub Interceptor] ${stage}${reasonCode ? ' :: ' + reasonCode : ''}`, detail || '');
    } catch (e) {}
    if (!persist) return;
    try {
      window.dispatchEvent(new CustomEvent('TUFHUB_DIAG', {
        detail: { stage, reasonCode: reasonCode || '', detail: detail == null ? '' : String(detail) }
      }));
    } catch (e) {}
  }

  // -------------------------------------------------------------
  // Submit-intent gate (replaces the old 45s wall-clock window)
  // -------------------------------------------------------------
  function loadArmState() {
    try {
      const raw = sessionStorage.getItem(ARM_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch (e) {}
    return { armed: false, epoch: 0, at: 0, slug: '' };
  }

  // sessionStorage preserves arm state across tab discard-and-restore, bfcache, and background freeze.
  let armState = loadArmState();

  function saveArmState() {
    try {
      sessionStorage.setItem(ARM_KEY, JSON.stringify(armState));
    } catch (e) {}
  }

  function arm(source) {
    markAlive();
    // NOTE: Active tab and Monaco code are snapshotted at arm time rather than verdict time.
    // Prevents slow judge polling from capturing the wrong tab if the user switches tabs while waiting.
    // Retains earlier snapshot data if the second arm call occurs while the tab bar is temporarily disabled.
    const tabInfo = getActiveTabInfo();
    const codeSnapshot = extractCodeFromMonaco();
    const sameProblem = armState.slug === currentProblemSlug();
    armState = {
      armed: true,
      epoch: (armState.epoch || 0) + 1,
      at: Date.now(),
      slug: currentProblemSlug(),
      tabLabel: tabInfo.count > 0 ? tabInfo.label : (sameProblem ? armState.tabLabel : ''),
      tabCount: tabInfo.count > 0 ? tabInfo.count : (sameProblem ? armState.tabCount : 0),
      code: codeSnapshot && codeSnapshot.trim().length > 0 ? codeSnapshot : (sameProblem ? armState.code : '')
    };
    // A fresh intent must never be suppressed by the previous verdict's id.
    lastProcessedSubmissionId = '';
    saveArmState();
    diag('ARMED', source, `epoch=${armState.epoch} slug=${armState.slug} tab=${armState.tabLabel}(${armState.tabCount})`);
  }

  function disarm(reason) {
    if (!armState.armed) return;
    armState = Object.assign({}, armState, { armed: false });
    saveArmState();
    diag('DISARMED', reason, '', false);
  }

  function isArmed() {
    if (!armState.armed) return false;
    if (Date.now() - (armState.at || 0) > ARM_MAX_AGE_MS) {
      disarm('SAFETY_CAP_EXPIRED');
      return false;
    }
    if (armState.slug && armState.slug !== currentProblemSlug()) {
      disarm('NAVIGATED_AWAY');
      return false;
    }
    return true;
  }

  // Provides a secondary gate opener when content.js detects a Submit button click or Ctrl+Enter.
  window.addEventListener('TUFHUB_USER_SUBMIT_CLICKED', () => {
    arm('USER_SUBMIT_CLICK');
  });

  function extractCodeFromMonaco() {
    try {
      if (window.monaco && window.monaco.editor) {
        // NOTE: getEditors()[0].getModel() targets the currently mounted, visible editor tab.
        // getModels()[0] is ordered by creation time and returns stale tab data when switching tabs.
        const editors = window.monaco.editor.getEditors ? window.monaco.editor.getEditors() : [];
        if (editors.length > 0) {
          const activeModel = editors[0].getModel();
          const activeVal = activeModel ? activeModel.getValue() : '';
          if (activeVal && activeVal.trim().length > 0) return activeVal;
        }
        // Only reached if getEditors() isn't available at all (older Monaco).
        const models = window.monaco.editor.getModels();
        if (models && models.length > 0) {
          const val = models[0].getValue();
          if (val && val.trim().length > 0) return val;
        }
      }
    } catch (e) {}

    try {
      const viewLines = document.querySelectorAll('.view-lines .view-line');
      if (viewLines.length > 0) {
        const text = Array.from(viewLines).map(line => line.innerText || line.textContent).join('\n');
        if (text.trim().length > 0) return text;
      }
    } catch (e) {}

    return '';
  }

  function extractLanguageFromDOM() {
    try {
      const langSelectors = document.querySelectorAll('button, div, span, select');
      for (const el of langSelectors) {
        const txt = (el.innerText || '').trim().toLowerCase();
        if (txt === 'c++' || txt === 'cpp') return 'cpp';
        if (txt === 'java') return 'java';
        if (txt === 'python' || txt === 'python3' || txt === 'py') return 'py';
        if (txt === 'javascript' || txt === 'js') return 'js';
        if (txt === 'typescript' || txt === 'ts') return 'ts';
        if (txt === 'c#' || txt === 'csharp') return 'cs';
        if (txt === 'go' || txt === 'golang') return 'go';
        if (txt === 'rust') return 'rs';
        if (txt === 'sql') return 'sql';
      }
    } catch (e) {}
    return 'cpp';
  }

  function extractDescriptionFromDOM() {
    try {
      const h1 = document.querySelector('h1');
      const panel =
        document.querySelector('[data-tuf-ai-selectable="true"]') ||
        document.querySelector('.problem-statement')?.closest('div.overflow-y-auto') ||
        document.querySelector('.problem-statement')?.parentElement?.parentElement ||
        document.querySelector('[class*="problem-statement"]')?.parentElement ||
        // Matches scrollable panel under h1 for revamped site layout where legacy classes are absent.
        (h1 && h1.closest('[class*="scrollable"]'));

      if (panel) {
        const clone = panel.cloneNode(true);
        const removeSelectors = [
          'button',
          'svg',
          '.difficulty-badge',
          '[class*="accordion"]',
          '[class*="hints"]',
          '[class*="sticky"]',
          '[class*="pointer-events-none"]'
        ];
        removeSelectors.forEach(sel => clone.querySelectorAll(sel).forEach(el => el.remove()));

        const html = clone.innerHTML;
        if (html && html.trim().length > 30) {
          return html;
        }
      }
    } catch (e) {}

    if (cachedProblemDescription && cachedProblemDescriptionSlug === currentProblemSlug() && cachedProblemDescription.length > 20) {
      return cachedProblemDescription;
    }

    return '';
  }

  /**
   * Extracts difficulty tier from the header button group adjacent to the problem title.
   * Scoped to the h1 parent container to avoid matching unrelated account badges on the page.
   * Falls back to 'Unspecified' rather than guessing when tier elements are absent.
   */
  function extractDifficultyFromDOM() {
    try {
      const h1 = document.querySelector('h1');
      const headerButtons = h1 && h1.parentElement ? Array.from(h1.parentElement.querySelectorAll('button')) : [];
      const tierBtn = headerButtons.find(b => {
        const t = (b.innerText || '').trim().toLowerCase();
        return t && t !== 'hints' && !t.startsWith('companies');
      });
      if (tierBtn) return tierBtn.innerText.trim();

      // Kept in case TUF ever reintroduces a literal difficulty class.
      const diffElem = document.querySelector('[class*="difficulty"]');
      if (diffElem) return diffElem.innerText.trim();
    } catch (e) {}
    return 'Unspecified';
  }

  function findSubmissionObject(obj) {
    if (!obj || typeof obj !== 'object') return null;

    if (Array.isArray(obj)) {
      if (obj.length > 0) return findSubmissionObject(obj[0]);
      return null;
    }

    if (Array.isArray(obj.submissions) && obj.submissions.length > 0) {
      return findSubmissionObject(obj.submissions[0]);
    }

    // Unambiguous verdict fields win outright.
    if (obj.verdict || obj.submission_status || obj.status_text) {
      return obj;
    }

    // A bare status is ambiguous because REST envelopes wrap results in {status: 'success', data: {...}}.
    // Downstream treats SUCCESS as an accepted verdict, so unpack nested data before checking bare status.
    if (obj.data) {
      const nested = findSubmissionObject(obj.data);
      if (nested) return nested;
    }

    if (obj.status) {
      return obj;
    }

    return null;
  }

  function processPayload(method, url, data) {
    if (!data) return;

    markAlive();
    const urlStr = url.toString().toLowerCase();

    // Cache Problem Details on page load
    if (urlStr.includes('/problem') && !urlStr.includes('/judge/')) {
      try {
        const prob = data.data || data.problem || data;
        const respSlug = currentProblemSlug();
        // Binds cached problem metadata directly to the active problem slug.
        // NOTE: Prevents single-page application navigation from leaking previous problem titles into subsequent syncs.
        if (prob.description) {
          cachedProblemDescription = prob.description;
          cachedProblemDescriptionSlug = respSlug;
        }
        if (prob.title || prob.name) {
          cachedProblemTitle = prob.title || prob.name;
          cachedProblemSlug = respSlug;
        }
        console.log('[TUFHub Interceptor] 📝 Cached problem metadata:', { title: cachedProblemTitle, slug: cachedProblemSlug, descLength: cachedProblemDescription.length });
      } catch (e) {}
      return;
    }

    // Ignore non-judge endpoints
    if (
      urlStr.includes('/drafts') ||
      urlStr.includes('/run') ||
      urlStr.includes('/track') ||
      urlStr.includes('/tabs')
    ) {
      return;
    }

    // Allowlist includes /judge/check-submit to capture poll responses from async SQL evaluations.
    if (
      !urlStr.includes('/judge/submit') &&
      !urlStr.includes('/judge/submissions') &&
      !urlStr.includes('/judge/check-submit') &&
      !urlStr.includes('/submission/result')
    ) {
      // Logs near-miss candidate endpoints to diagnostics so API changes remain visible.
      if (urlStr.includes('judge') || urlStr.includes('verdict') || urlStr.includes('submission')) {
        diag('UNMATCHED_ENDPOINT', 'ENDPOINT_NOT_IN_ALLOWLIST', `${method} ${urlStr}`);
      }
      return;
    }

    // POST /judge/submit confirms submission intent: arms the gate and stops prior to verdict evaluation.
    // NOTE: This response carries queued submission metadata rather than a verdict; evaluating it directly risks false positives.
    if (method === 'POST' && urlStr.includes('/judge/submit')) {
      arm('POST_JUDGE_SUBMIT');
      return;
    }

    // GATE: ignore page-load history fetches unless a submit intent is live.
    if (!isArmed()) {
      diag('IGNORED', 'NOT_ARMED', 'No live submit intent (page-load history fetch).', false);
      return;
    }

    console.log('[TUFHub Interceptor] 📡 Judge API Payload Intercepted:', { method, url: urlStr, data });

    const targetObj = findSubmissionObject(data);
    if (!targetObj) {
      diag('WAITING', 'NO_SUBMISSION_OBJECT', `${method} ${urlStr}`, false);
      return;
    }

    const rawVerdict = (targetObj.verdict || targetObj.status || targetObj.submission_status || '').toString().trim().toUpperCase();

    if (!rawVerdict.includes('ACCEPTED') && rawVerdict !== 'SUCCESS') {
      diag('WAITING', 'VERDICT_NOT_ACCEPTED', rawVerdict, false);
      return;
    }

    const passed = targetObj.passed_test_cases ?? targetObj.passedTestCases ?? targetObj.passed;
    const total = targetObj.total_test_cases ?? targetObj.totalTestCases ?? targetObj.total;

    if (total !== undefined && passed !== undefined && total > 0 && passed < total) {
      diag('DROPPED', 'PARTIAL_TEST_CASES', `${passed}/${total}`);
      return;
    }

    // Deduplication key bound to problem slug and submit epoch so fresh submissions generate distinct keys.
    // NOTE: Legacy fallback keys based on url and test case counts permanently suppressed re-submissions for the life of the document.
    const submissionId = targetObj.submission_id || targetObj.id ||
      `${currentProblemSlug()}_e${armState.epoch}_${passed}_${total}`;

    if (submissionId === lastProcessedSubmissionId) {
      diag('DROPPED', 'DUPLICATE_SUBMISSION_ID', String(submissionId));
      return;
    }
    lastProcessedSubmissionId = submissionId;
    disarm('VERDICT_DISPATCHED');

    console.log('%c[TUFHub Interceptor] 🎉 100% PASSED ACCEPTED SUBMISSION CONFIRMED!', 'color: #3b82f6; font-weight: bold; font-size: 13px;', { verdict: rawVerdict, passed, total });

    // Prefers arm-time snapshotted code over verdict-time scraping to protect against tab switching.
    const code = targetObj.code || targetObj.solution || targetObj.source_code || armState.code || extractCodeFromMonaco();
    const language = targetObj.language || targetObj.lang || extractLanguageFromDOM();

    // Queries h1 directly to avoid sidebar title elements from colliding with the active problem title.
    // Falls back to URL slug derivation when h1 is absent from the active view.
    const h1Elem = document.querySelector('h1');

    const slugNow = currentProblemSlug();
    const cachedTitleIsFresh = cachedProblemTitle && cachedProblemSlug === slugNow;
    const title = (cachedTitleIsFresh ? cachedProblemTitle : '') ||
      (h1Elem ? h1Elem.innerText.trim() : titleFromSlug(slugNow));
    const difficulty = extractDifficultyFromDOM();
    const description = extractDescriptionFromDOM();

    diag('VERDICT_ACCEPTED', 'DISPATCHING', `${slugNow} ${passed}/${total}`);

    window.dispatchEvent(new CustomEvent('TUFHUB_ACCEPTED_SUBMISSION', {
      detail: {
        code,
        language,
        title,
        difficulty,
        description,
        url: window.location.href,
        timestamp: Date.now(),
        tabLabel: armState.tabLabel || '',
        tabCount: armState.tabCount || 0
      }
    }));
  }

  // -------------------------------------------------------------
  // Self-healing fetch hook
  // -------------------------------------------------------------
  function requestMeta(input, init) {
    let url = '';
    let method = 'GET';
    try {
      if (typeof Request !== 'undefined' && input instanceof Request) {
        // Extracts url and method directly from Request instances where String(input) yields '[object Request]'.
        // NOTE: Direct property extraction ensures Request-style fetch calls remain visible to the payload matcher.
        url = input.url;
        method = input.method || 'GET';
      } else {
        url = input ? input.toString() : '';
      }
      if (init && init.method) method = init.method;
    } catch (e) {}
    return { url, method: (method || 'GET').toUpperCase() };
  }

  function wrapFetch(target) {
    if (typeof target !== 'function' || target.__tufhubWrapped) return target;

    const wrapped = function (...args) {
      const { url, method } = requestMeta(args[0], args[1]);
      return target.apply(this, args).then((response) => {
        try {
          response.clone().json().then((data) => {
            processPayload(method, url, data);
          }).catch(() => {});
        } catch (e) {}
        return response;
      });
    };
    wrapped.__tufhubWrapped = true;
    wrapped.__tufhubOriginal = target;
    return wrapped;
  }

  let installedFetch = wrapFetch(window.fetch);

  try {
    // Property descriptor setter re-wraps subsequent assignments to window.fetch so the hook persists.
    // NOTE: Direct assignments can be clobbered by lazy polyfills or analytics SDKs, blinding detection for the document lifetime.
    // NOTE: The setter re-wraps any subsequent reassignment so the interception hook reliably survives.
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      enumerable: true,
      get() {
        return installedFetch;
      },
      set(next) {
        installedFetch = wrapFetch(next);
        diag('FETCH_REWRAPPED', 'PAGE_REASSIGNED_FETCH', '');
      }
    });
  } catch (e) {
    window.fetch = installedFetch;
  }

  // Hook XMLHttpRequest
  const originalXOpen = XMLHttpRequest.prototype.open;
  const originalXSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._tufhub_method = method ? method.toUpperCase() : 'GET';
    this._tufhub_url = url;
    return originalXOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try {
        if (this.responseText) {
          const data = JSON.parse(this.responseText);
          processPayload(this._tufhub_method, this._tufhub_url, data);
        }
      } catch (e) {}
    });
    return originalXSend.apply(this, arguments);
  };

})();
