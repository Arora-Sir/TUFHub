/**
 * TUFHub Page Interceptor (MAIN World)
 * Direct Recursive Payload Matcher with User Submission Gate (Prevents Page Load Auto-Sync)
 * Author: Mohit Arora (@Arora-Sir)
 */




(function () {
  if (window.__TUFHUB_INTERCEPTOR_INITED__) return;
  window.__TUFHUB_INTERCEPTOR_INITED__ = true;

  console.log('%c[TUFHub Interceptor] 🚀 MAIN world fetch/XHR hook active.', 'color: #22c55e; font-weight: bold; font-size: 13px;');

  let cachedProblemDescription = '';
  let cachedProblemTitle = '';
  let lastProcessedSubmissionId = '';

  let userSubmitTimestamp = 0;
  let activeSubmissionId = '';

  // Listen for explicit Submit click or Ctrl+Enter from content script
  window.addEventListener('TUFHUB_USER_SUBMIT_CLICKED', () => {
    userSubmitTimestamp = Date.now();
    console.log('%c[TUFHub Interceptor] 🎯 User Submit Intent Registered!', 'color: #3b82f6; font-weight: bold;');
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

    if (obj.verdict || obj.submission_status || obj.status_text || obj.status) {
      return obj;
    }

    if (obj.data) {
      return findSubmissionObject(obj.data);
    }

    return null;
  }

  function processPayload(method, url, data) {
    if (!data) return;

    const urlStr = url.toString().toLowerCase();

    // Cache Problem Details on page load
    if (urlStr.includes('/problem') && !urlStr.includes('/judge/')) {
      try {
        const prob = data.data || data.problem || data;
        if (prob.description) cachedProblemDescription = prob.description;
        if (prob.title || prob.name) cachedProblemTitle = prob.title || prob.name;
        console.log('[TUFHub Interceptor] 📝 Cached problem metadata:', { title: cachedProblemTitle, descLength: cachedProblemDescription.length });
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
      return;
    }

    // 1. If this is a POST to /judge/submit, user just clicked Submit!
    if (method === 'POST' && urlStr.includes('/judge/submit')) {
      userSubmitTimestamp = Date.now();
      const targetSubId = data.data?.submission_id || data.submission_id || data.data?.id;
      if (targetSubId) {
        activeSubmissionId = targetSubId;
      }
      console.log('%c[TUFHub Interceptor] 🚀 Active Submission Initiated via POST /judge/submit!', 'color: #8b5cf6; font-weight: bold;', { activeSubmissionId });
      return;
    }

    // 2. CRITICAL GATE: Ignore GET requests on page load UNLESS user clicked Submit within last 45 seconds!
    const isWithinSubmitWindow = (Date.now() - userSubmitTimestamp) < 45000;
    if (!isWithinSubmitWindow) {
      console.log('[TUFHub Interceptor] ℹ️ Page-load history fetch ignored (User did not click Submit recently).');
      return;
    }

    console.log('[TUFHub Interceptor] 📡 Judge API Payload Intercepted:', { method, url: urlStr, data });

    const targetObj = findSubmissionObject(data);
    if (!targetObj) {
      return;
    }

    const rawVerdict = (targetObj.verdict || targetObj.status || targetObj.submission_status || '').toString().trim().toUpperCase();
    
    if (!rawVerdict.includes('ACCEPTED') && rawVerdict !== 'SUCCESS') {
      console.log(`[TUFHub Interceptor] ⏳ Waiting: Verdict is "${rawVerdict}" (not ACCEPTED yet).`);
      return;
    }

    const passed = targetObj.passed_test_cases ?? targetObj.passedTestCases ?? targetObj.passed;
    const total = targetObj.total_test_cases ?? targetObj.totalTestCases ?? targetObj.total;

    if (total !== undefined && passed !== undefined && total > 0 && passed < total) {
      console.warn(`[TUFHub Interceptor] 🛑 Ignored: Test cases incomplete (${passed}/${total} passed).`);
      return;
    }

    const submissionId = targetObj.submission_id || targetObj.id || `${urlStr}_${passed}_${total}`;
    if (submissionId === lastProcessedSubmissionId) return;
    lastProcessedSubmissionId = submissionId;
    userSubmitTimestamp = 0; // Reset gate after successful trigger

    console.log('%c[TUFHub Interceptor] 🎉 100% PASSED ACCEPTED SUBMISSION CONFIRMED!', 'color: #3b82f6; font-weight: bold; font-size: 13px;', { verdict: rawVerdict, passed, total });

    const code = targetObj.code || targetObj.solution || targetObj.source_code || extractCodeFromMonaco();
    const language = targetObj.language || targetObj.lang || extractLanguageFromDOM();

    const titleElem = document.querySelector('h1, [class*="title"], [class*="problem-name"]');
    const diffElem = document.querySelector('[class*="difficulty"], [class*="badge"]');

    const title = cachedProblemTitle || (titleElem ? titleElem.innerText.trim() : '');
    const difficulty = diffElem ? diffElem.innerText.trim() : 'Medium';
    const description = extractDescriptionFromDOM();

    console.log('[TUFHub Interceptor] 📤 Dispatching TUFHUB_ACCEPTED_SUBMISSION custom event...');

    window.dispatchEvent(new CustomEvent('TUFHUB_ACCEPTED_SUBMISSION', {
      detail: {
        code,
        language,
        title,
        difficulty,
        description,
        url: window.location.href,
        timestamp: Date.now()
      }
    }));
  }

  // Hook fetch
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = args[0] ? args[0].toString() : '';
    const options = args[1] || {};
    const method = (options.method || 'GET').toUpperCase();

    return originalFetch.apply(this, args).then((response) => {
      try {
        response.clone().json().then((data) => {
          processPayload(method, url, data);
        }).catch(() => {});
      } catch (e) {}
      return response;
    });
  };

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
