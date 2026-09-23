/**
 * TUFHub Offline Page Extraction
 * Reads title and problem-statement HTML from a DOMParser-parsed TUF page fetched directly over the network, not a live rendered tab.
 * Mirrors interceptor.js's DOM readers, but every read uses textContent, never innerText: innerText depends on the layout box tree, and a DOMParser document is never attached to one, so innerText silently returns '' here instead of throwing.
 * NOTE: Difficulty is deliberately not read here. TUF only fills the tier badge in client-side after hydration, so a plain fetch's HTML never contains it, confirmed live: a fresh anonymous fetch of a real problem page has zero occurrences of "Basic", "Easy", "Medium", or "Hard" anywhere. Callers should keep the difficulty already on record for that problem instead.
 * Author: Mohit Arora (@Arora-Sir)
 */

const JUNK_SELECTORS = [
  'button',
  'svg',
  '.difficulty-badge',
  '[class*="accordion"]',
  '[class*="hints"]',
  '[class*="sticky"]',
  '[class*="pointer-events-none"]'
];

/**
 * Given a Document (from `new DOMParser().parseFromString(html, 'text/html')`), returns { title, description }.
 * description is the raw problem-statement HTML, the same shape buildProblemReadme()/convertTufHtmlToMarkdown() already expects.
 */
export function extractProblemFields(doc) {
  const h1 = doc.querySelector('h1');
  const rawTitle = h1 ? (h1.textContent || '').trim() : '';
  // TUF prefixes some titles with a numeric id ("46. Highest Non-Repeating Number"); strip it so it matches the plain title already stored from the original sync.
  const title = rawTitle.replace(/^\d+\.\s*/, '');

  const panel =
    doc.querySelector('[data-tuf-ai-selectable="true"]') ||
    doc.querySelector('.problem-statement')?.closest('div.overflow-y-auto') ||
    doc.querySelector('.problem-statement')?.parentElement?.parentElement ||
    doc.querySelector('[class*="problem-statement"]')?.parentElement ||
    (h1 && h1.closest('[class*="scrollable"]'));

  let description = '';
  if (panel) {
    const clone = panel.cloneNode(true);
    JUNK_SELECTORS.forEach(sel => clone.querySelectorAll(sel).forEach(el => el.remove()));
    const html = clone.innerHTML;
    if (html && html.trim().length > 30) description = html;
  }

  return { title, description };
}
