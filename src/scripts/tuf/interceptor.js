/**
 * TUFHub Page Interceptor (MAIN World)
 * Strictly intercepts active 100% PASSED ACCEPTED POST submissions!
 * Author: Mohit Arora (@Arora-Sir)
 */

(function () {
  if (window.__TUFHUB_INTERCEPTOR_INITED__) return;
  window.__TUFHUB_INTERCEPTOR_INITED__ = true;

  console.log('[TUFHub Debug] Main world fetch/XHR interceptor active.');

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
      const langElem = document.querySelector('[class*="language"], [class*="lang-select"], button[class*="select"]');
      if (langElem) {
        const txt = langElem.innerText.trim();
        if (txt) return txt;
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

  function processPayload(method, url, data) {
    if (!data) return;

    const urlStr = url.toString().toLowerCase();

    // 1. Cache Problem Details when page loads problem data
    if (urlStr.includes('/plus/problem/') || urlStr.includes('/problem/details') || urlStr.includes('/drafts/tabs')) {
      try {
        const prob = data.data || data.problem || data;
        if (prob.description) cachedProblemDescription = prob.description;
        if (prob.title || prob.name) cachedProblemTitle = prob.title || prob.name;
        console.log('[TUFHub Debug] Cached problem metadata:', { title: cachedProblemTitle, descLength: cachedProblemDescription.length });
      } catch (e) {}
      return;
    }

    // IGNORE all GET requests & history endpoints
    if (method === 'GET' || urlStr.includes('/judge/submissions?') || urlStr.includes('/progress') || urlStr.includes('/drafts')) {
      return;
    }

    // ONLY process POST/PUT endpoints related to judge submission execution or submission result polling
    if (!urlStr.includes('/judge/submit') && !urlStr.includes('/judge/submission/result') && !urlStr.includes('/judge/run')) {
      return;
    }

    // Check 100% test cases passed enforcement
    const total = data.total_test_cases ?? data.data?.total_test_cases;
    const passed = data.passed_test_cases ?? data.data?.passed_test_cases;

    if (total !== undefined && passed !== undefined && total > 0 && passed < total) {
      console.log(`[TUFHub Debug] Submission incomplete (${passed}/${total} test cases passed). Skipping sync.`);
      return;
    }

    const isAccepted = 
      (data.verdict === 'Accepted' || data.verdict === 'ACCEPTED') ||
      (data.status === 'SUCCESS' && data.verdict === 'Accepted') ||
      (data.success === true && (data.verdict === 'Accepted' || data.verdict === 'ACCEPTED')) ||
      (data.data && (data.data.verdict === 'Accepted' || data.data.verdict === 'ACCEPTED'));

    if (isAccepted) {
      const submissionId = data.submission_id || data.id || data.data?.submission_id || `${urlStr}_${Date.now()}`;
      if (submissionId === lastProcessedSubmissionId) {
        return; // Deduplicate poll results
      }
      lastProcessedSubmissionId = submissionId;

      console.log('[TUFHub Debug] 100% Passed Active Submission ACCEPTED!', { method, url, data });

      const code = data.code || data.solution || data.source_code || extractCodeFromMonaco();
      const language = data.language || data.lang || extractLanguageFromDOM();

      const titleElem = document.querySelector('h1, [class*="title"], [class*="problem-name"]');
      const diffElem = document.querySelector('[class*="difficulty"], [class*="badge"]');

      const title = cachedProblemTitle || (titleElem ? titleElem.innerText.trim() : '');
      const difficulty = diffElem ? diffElem.innerText.trim() : 'Medium';
      const description = extractDescriptionFromDOM();

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
