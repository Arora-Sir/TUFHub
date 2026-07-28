/**
 * TUFHub Page Interceptor (MAIN World)
 * Hooks window.fetch + XMLHttpRequest
 * MUST ONLY trigger on 100% PASSED ACCEPTED submissions (passed_test_cases === total_test_cases)!
 * Author: Mohit Arora (@Arora-Sir)
 */

(function () {
  if (window.__TUFHUB_INTERCEPTOR_INITED__) return;
  window.__TUFHUB_INTERCEPTOR_INITED__ = true;

  console.log('[TUFHub Debug] Main world fetch/XHR interceptor active.');

  let cachedProblemDescription = '';
  let cachedProblemTitle = '';

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
    if (cachedProblemDescription && cachedProblemDescription.length > 20) {
      return cachedProblemDescription;
    }

    try {
      // Find clean problem statement element (ignoring tabbar headers)
      const descElem = document.querySelector('[class*="prose"], [class*="markdown"], [id*="problem-statement"]');
      if (descElem) {
        const clone = descElem.cloneNode(true);
        // Remove tabbar elements
        clone.querySelectorAll('[class*="tabbar"], button, [role="tab"]').forEach(el => el.remove());
        return clone.innerHTML;
      }
    } catch (e) {}

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

    // IGNORE past submission list history, draft tabs, progress GET endpoints!
    if (urlStr.includes('/judge/submissions') || urlStr.includes('/progress') || urlStr.includes('/drafts') || method === 'GET') {
      return;
    }

    // 2. Only process POST/PUT submission / judge submit result endpoints
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    
    // Check 100% test cases passed enforcement
    const total = data.total_test_cases ?? data.data?.total_test_cases;
    const passed = data.passed_test_cases ?? data.data?.passed_test_cases;

    if (total !== undefined && passed !== undefined && total > 0 && passed < total) {
      console.log(`[TUFHub Debug] Submission NOT 100% passed (${passed}/${total} test cases). Skipping sync.`);
      return;
    }

    const isAccepted = 
      (data.verdict === 'Accepted' || data.verdict === 'ACCEPTED') ||
      (data.status === 'SUCCESS' && data.verdict === 'Accepted') ||
      (data.success === true && (data.verdict === 'Accepted' || data.verdict === 'ACCEPTED')) ||
      (data.data && (data.data.verdict === 'Accepted' || data.data.verdict === 'ACCEPTED'));

    if (isAccepted) {
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

  // 3. Monaco Scrape Event Listener
  window.addEventListener('TUFHUB_TRIGGER_MONACO_SCRAPE', () => {
    const code = extractCodeFromMonaco();
    const language = extractLanguageFromDOM();
    const titleElem = document.querySelector('h1, [class*="title"], [class*="problem-name"]');
    const diffElem = document.querySelector('[class*="difficulty"], [class*="badge"]');

    window.dispatchEvent(new CustomEvent('TUFHUB_ACCEPTED_SUBMISSION', {
      detail: {
        code,
        language,
        title: cachedProblemTitle || (titleElem ? titleElem.innerText.trim() : ''),
        difficulty: diffElem ? diffElem.innerText.trim() : 'Medium',
        description: extractDescriptionFromDOM(),
        url: window.location.href,
        timestamp: Date.now()
      }
    }));
  });

})();
