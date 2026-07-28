/**
 * TUFHub Page Interceptor (MAIN World)
 * Direct Recursive Payload Matcher: Finds verdict & test cases across nested data.submissions arrays!
 * Author: Mohit Arora (@Arora-Sir)
 */

var __name = function (target, value) {
  try {
    return Object.defineProperty(target, 'name', { value: value, configurable: true });
  } catch (e) {
    return target;
  }
};

(function () {
  if (window.__TUFHUB_INTERCEPTOR_INITED__) return;
  window.__TUFHUB_INTERCEPTOR_INITED__ = true;

  console.log('%c[TUFHub Interceptor] 🚀 MAIN world fetch/XHR hook active.', 'color: #22c55e; font-weight: bold; font-size: 13px;');

  let cachedProblemDescription = '';
  let cachedProblemTitle = '';
  let lastProcessedSubmissionId = '';

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

  /**
   * Recursively unwrap payload to locate submission object containing verdict/test cases
   */
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

    // 1. Cache Problem Details when page loads problem data
    if (urlStr.includes('/problem') && !urlStr.includes('/judge/')) {
      try {
        const prob = data.data || data.problem || data;
        if (prob.description) cachedProblemDescription = prob.description;
        if (prob.title || prob.name) cachedProblemTitle = prob.title || prob.name;
        console.log('[TUFHub Interceptor] 📝 Cached problem metadata:', { title: cachedProblemTitle, descLength: cachedProblemDescription.length });
      } catch (e) {}
      return;
    }

    // IGNORE DRAFTS, RUN, TRACK, AND TABS
    if (
      urlStr.includes('/drafts') ||
      urlStr.includes('/run') ||
      urlStr.includes('/track') ||
      urlStr.includes('/tabs')
    ) {
      return;
    }

    // MUST BE /judge/submit OR /judge/submissions!
    if (!urlStr.includes('/judge/submit') && !urlStr.includes('/judge/submissions') && !urlStr.includes('/submission/result')) {
      return;
    }

    console.log('[TUFHub Interceptor] 📡 Judge API Payload Intercepted:', { method, url: urlStr, data });

    // Recursively extract target submission object
    const targetObj = findSubmissionObject(data);
    if (!targetObj) {
      console.log('[TUFHub Interceptor] ⏳ Waiting: No submission object found in payload.');
      return;
    }

    const rawVerdict = (targetObj.verdict || targetObj.status || targetObj.submission_status || '').toString().trim().toUpperCase();
    
    // VERDICT MUST BE ACCEPTED!
    if (!rawVerdict.includes('ACCEPTED') && rawVerdict !== 'SUCCESS') {
      console.log(`[TUFHub Interceptor] ⏳ Waiting: Verdict is "${rawVerdict}" (not ACCEPTED yet).`);
      return;
    }

    const passed = targetObj.passed_test_cases ?? targetObj.passedTestCases ?? targetObj.passed;
    const total = targetObj.total_test_cases ?? targetObj.totalTestCases ?? targetObj.total;

    // Test cases MUST be 100% passed!
    if (total !== undefined && passed !== undefined && total > 0 && passed < total) {
      console.warn(`[TUFHub Interceptor] 🛑 Ignored: Test cases incomplete (${passed}/${total} passed).`);
      return;
    }

    const submissionId = targetObj.submission_id || targetObj.id || `${urlStr}_${passed}_${total}_${Date.now()}`;
    if (submissionId === lastProcessedSubmissionId) return;
    lastProcessedSubmissionId = submissionId;

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

  // 1. Hook window.fetch
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

  // 2. Hook XMLHttpRequest
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
