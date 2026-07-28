/**
 * TUFHub Page Interceptor Script
 * Runs at document_start in MAIN world on takeuforward.org/plus/*
 * Author: Mohit Arora (@Arora-Sir)
 */

(function () {
  if (window.__TUFHUB_INTERCEPTOR_INITED__) return;
  window.__TUFHUB_INTERCEPTOR_INITED__ = true;

  console.log('[TUFHub] Interceptor injected successfully.');

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    return originalFetch.apply(this, args).then((response) => {
      try {
        const url = args[0] ? args[0].toString() : '';
        // Match TUF+ submission endpoints
        if (url.includes('/api/') && (url.includes('/submit') || url.includes('/run'))) {
          response.clone().json().then((data) => {
            if (data && (data.verdict === 'Accepted' || data.status === 'Accepted' || data.success === true)) {
              console.log('[TUFHub] Intercepted Accepted Submission:', data);
              
              // Scrape additional DOM info at the moment of submission
              const titleElem = document.querySelector('h1, [class*="title"], [class*="problem-name"]');
              const diffElem = document.querySelector('[class*="difficulty"], [class*="badge"]');
              const descElem = document.querySelector('[class*="description"], [class*="problem-statement"]');
              
              const title = titleElem ? titleElem.innerText.trim() : 'Unknown Problem';
              const difficulty = diffElem ? diffElem.innerText.trim() : 'Medium';
              const description = descElem ? descElem.innerHTML : '';
              
              window.dispatchEvent(new CustomEvent('TUFHUB_ACCEPTED_SUBMISSION', {
                detail: {
                  code: data.code || data.solution || '',
                  language: data.language || data.lang || 'cpp',
                  title,
                  difficulty,
                  description,
                  url: window.location.href,
                  timestamp: Date.now()
                }
              }));
            }
          }).catch(() => {});
        }
      } catch (e) {
        console.error('[TUFHub] Error in fetch interceptor:', e);
      }
      return response;
    });
  };
})();
