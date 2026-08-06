/**
 * TUFHub Page Interceptor (MAIN World)
 * Intent-gated payload matcher with a self-healing fetch/XHR hook.
 * Author: Mohit Arora (@Arora-Sir)
 */




(function () {
  if (window.__TUFHUB_INTERCEPTOR_INITED__) return;
  window.__TUFHUB_INTERCEPTOR_INITED__ = true;

  const TUFHUB_VERSION = process.env.TUFHUB_VERSION || '0.0.0';

  // Absolute safety cap. This is NOT a race against the judge - the gate stays
  // open until a verdict arrives, the user navigates away, or this cap trips.
  // The old build used a 45s window, which silently dropped every verdict from
  // a cold judge (typically the first submission after an idle period).
  const ARM_MAX_AGE_MS = 10 * 60 * 1000;
  const ARM_KEY = '__tufhub_arm_state__';

  console.log(`%c[TUFHub Interceptor v${TUFHUB_VERSION}] 🚀 MAIN world fetch/XHR hook active.`, 'color: #22c55e; font-weight: bold; font-size: 13px;');

  // Liveness marker readable from the isolated world (CustomEvents dispatched at
  // document_start would be missed - content.js only starts at document_idle).
  // Re-asserted on activity in case a framework re-render strips it.
  function markAlive() {
    try {
      if (document.documentElement.getAttribute('data-tufhub-interceptor') !== TUFHUB_VERSION) {
        document.documentElement.setAttribute('data-tufhub-interceptor', TUFHUB_VERSION);
      }
    } catch (e) {}
  }
  markAlive();

  let cachedProblemDescription = '';
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

  /**
   * TUF+'s multi-tab editor (up to 4 tabs per problem) has no ARIA tab semantics -
   * just styled divs. The `Close <label>` aria-label is a more stable anchor than
   * the exact Tailwind class soup for finding tabs; "which one is active" still
   * needs a class heuristic (confirmed live: active = text-black/dark:text-white,
   * inactive = text-zinc-500/dark:text-zinc-500, only on hover).
   * Returns { label: '', count: 0 } on any scrape failure so callers degrade to
   * the legacy single-file behavior rather than guess at a wrong filename.
   */
  function getActiveTabInfo() {
    try {
      const closeButtons = Array.from(document.querySelectorAll('button[aria-label^="Close "]'));
      if (closeButtons.length === 0) return { label: '', count: 0 };
      const containers = closeButtons.map(btn => ({
        label: (btn.getAttribute('aria-label') || '').replace(/^Close\s+/i, '').trim(),
        container: btn.parentElement
      })).filter(c => c.label && c.container);
      if (containers.length === 0) return { label: '', count: 0 };
      const active = containers.find(c => /text-black|dark:text-white/.test(c.container.className || ''));
      return { label: (active || containers[0]).label, count: containers.length };
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

  // sessionStorage keeps the gate armed across tab freeze, discard-and-restore
  // and bfcache, which plain closure state does not survive.
  let armState = loadArmState();

  function saveArmState() {
    try {
      sessionStorage.setItem(ARM_KEY, JSON.stringify(armState));
    } catch (e) {}
  }

  function arm(source) {
    markAlive();
    // Captured now, not at verdict-time: avoids the race where a slow judge
    // resolves after the user has already switched to a different tab.
    //
    // arm() fires twice per real submission - once on the click (before TUF's
    // own handler runs) and again when the POST /judge/submit request is
    // observed (after it runs, by which point TUF may have transiently hidden
    // or disabled the tab bar for the "submitting" state). A scrape failure on
    // that second call must not clobber the good data the first call already
    // captured, or every multi-tab sync silently falls back to solution.<ext>.
    const tabInfo = getActiveTabInfo();
    const sameProblem = armState.slug === currentProblemSlug();
    armState = {
      armed: true,
      epoch: (armState.epoch || 0) + 1,
      at: Date.now(),
      slug: currentProblemSlug(),
      tabLabel: tabInfo.count > 0 ? tabInfo.label : (sameProblem ? armState.tabLabel : ''),
      tabCount: tabInfo.count > 0 ? tabInfo.count : (sameProblem ? armState.tabCount : 0)
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

  // Dispatched by content.js on a real Submit click / Ctrl+Enter. This gives the
  // gate a second, independent opener so detection no longer depends solely on
  // observing the POST /judge/submit response.
  window.addEventListener('TUFHUB_USER_SUBMIT_CLICKED', () => {
    arm('USER_SUBMIT_CLICK');
  });

  function extractCodeFromMonaco() {
    try {
      if (window.monaco && window.monaco.editor) {
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
      const panel =
        document.querySelector('[data-tuf-ai-selectable="true"]') ||
        document.querySelector('.problem-statement')?.closest('div.overflow-y-auto') ||
        document.querySelector('.problem-statement')?.parentElement?.parentElement ||
        document.querySelector('[class*="problem-statement"]')?.parentElement;

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

    if (cachedProblemDescription && cachedProblemDescription.length > 20) {
      return cachedProblemDescription;
    }

    return '';
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

    // A bare `status` is ambiguous: REST envelopes use {status:'success', data:{...}},
    // and 'SUCCESS' is treated as an accepted verdict downstream. Always prefer a
    // nested payload so the wrapper is not mistaken for the verdict itself.
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
        if (prob.description) cachedProblemDescription = prob.description;
        if (prob.title || prob.name) cachedProblemTitle = prob.title || prob.name;
        // Bind the cache to the slug it was captured on, so an SPA navigation
        // cannot leak the previous problem's title into the next sync.
        cachedProblemSlug = currentProblemSlug();
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

    // Must be judge submit or judge submissions
    if (!urlStr.includes('/judge/submit') && !urlStr.includes('/judge/submissions') && !urlStr.includes('/submission/result')) {
      // Surface near-misses so an endpoint rename on TUF's side is visible
      // instead of killing detection silently.
      if (urlStr.includes('judge') || urlStr.includes('verdict') || urlStr.includes('submission')) {
        diag('UNMATCHED_ENDPOINT', 'ENDPOINT_NOT_IN_ALLOWLIST', `${method} ${urlStr}`);
      }
      return;
    }

    // 1. POST to /judge/submit means the user definitely submitted. Arm the gate
    //    and stop: this response carries the queued submission, not a verdict,
    //    and evaluating it risks reading an API envelope as an "accepted".
    if (method === 'POST' && urlStr.includes('/judge/submit')) {
      arm('POST_JUDGE_SUBMIT');
      return;
    }

    // 2. GATE: ignore page-load history fetches unless a submit intent is live.
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

    // Dedupe key. The old fallback was `${url}_${passed}_${total}`, which is
    // identical across re-submits of the same problem (and across different
    // problems with the same test-case count), permanently suppressing them for
    // the life of the document. Binding to the slug + submit epoch makes every
    // fresh Submit produce a distinct key.
    const submissionId = targetObj.submission_id || targetObj.id ||
      `${currentProblemSlug()}_e${armState.epoch}_${passed}_${total}`;

    if (submissionId === lastProcessedSubmissionId) {
      diag('DROPPED', 'DUPLICATE_SUBMISSION_ID', String(submissionId));
      return;
    }
    lastProcessedSubmissionId = submissionId;
    disarm('VERDICT_DISPATCHED');

    console.log('%c[TUFHub Interceptor] 🎉 100% PASSED ACCEPTED SUBMISSION CONFIRMED!', 'color: #3b82f6; font-weight: bold; font-size: 13px;', { verdict: rawVerdict, passed, total });

    const code = targetObj.code || targetObj.solution || targetObj.source_code || extractCodeFromMonaco();
    const language = targetObj.language || targetObj.lang || extractLanguageFromDOM();

    const titleElem = document.querySelector('h1, [class*="title"], [class*="problem-name"]');
    const diffElem = document.querySelector('[class*="difficulty"], [class*="badge"]');

    const slugNow = currentProblemSlug();
    const cachedTitleIsFresh = cachedProblemTitle && cachedProblemSlug === slugNow;
    const title = (cachedTitleIsFresh ? cachedProblemTitle : '') || (titleElem ? titleElem.innerText.trim() : '');
    const difficulty = diffElem ? diffElem.innerText.trim() : 'Medium';
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
        // Plain String(input) on a Request yields "[object Request]", which used
        // to make every Request-style fetch invisible to the matcher.
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
    // A plain assignment can be silently clobbered later by a lazily-loaded
    // polyfill, an analytics SDK or another extension, which would blind
    // detection for the life of the document with no way to recover. The setter
    // re-wraps whatever anyone assigns, so the hook always survives.
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
