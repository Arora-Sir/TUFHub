/**
 * TUFHub Repository Repair
 * Detects and rewrites stale TUF problem links, and detects unfixed box-art content, in already-synced READMEs.
 * Author: Mohit Arora (@Arora-Sir)
 */

const STALE_URL_PREFIX = 'https://takeuforward.org/plus/';

// TUF moved DSA and SQL problem pages off /plus/<subject>/.../<slug> to /practice/<subject>/<slug> without redirects, so every link using the old prefix is dead.
export function isStaleUrl(url) {
  return typeof url === 'string' && url.startsWith(STALE_URL_PREFIX);
}

/**
 * Rewrites an old /plus/ URL to its current /practice/ form.
 * The subject is always the path segment right after /plus/, and the slug is always the last path segment before the query string, regardless of how many topic/subtopic segments TUF puts in between (both shapes are confirmed live: /plus/dsa/problems/<slug> and /plus/dsa/<topic>/<subtopic>/<slug>).
 * Returns null when the URL doesn't fit this shape, so callers can skip it rather than construct a wrong link.
 */
export function rewriteStaleUrl(url) {
  if (!isStaleUrl(url)) return null;
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean); // ['plus', subject, ...topic segments..., slug]
    if (parts.length < 3 || parts[0] !== 'plus') return null;
    const subject = parts[1];
    const slug = parts[parts.length - 1];
    if (!subject || !slug) return null;
    return `https://takeuforward.org/practice/${subject}/${slug}`;
  } catch (e) {
    return null;
  }
}

/**
 * The URL to actually fetch a problem's live page from, for either a stale or an already-current link.
 * NOTE: A query string alone can make TUF skip server-rendering the real problem content for an anonymous request. Confirmed live: the same already-current /practice/... URL with a lingering &tab=solution from the original sync returned a stripped, login-gated shell with no <h1> at all, while the identical URL with its query string dropped rendered the real title and description. The query params TUF adds (category, source, tab) are its own UI breadcrumb state, not needed to resolve the page, so they are always dropped here regardless of which form the stored link was in.
 */
export function canonicalProblemUrl(url) {
  const staleTarget = rewriteStaleUrl(url);
  if (staleTarget) return staleTarget;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'takeuforward.org' || !/^\/practice\//.test(parsed.pathname)) return null;
    return `https://takeuforward.org${parsed.pathname}`;
  } catch (e) {
    return null;
  }
}

// Every Unicode box-drawing glyph (═║╔╗╚╝╠╣╦╩╬─│┌┐└┘├┤┬┴┼ and friends), not just the handful this bug happened to produce, so any future variant of the same bug is still caught.
const BOX_DRAWING_RE = /[─-╿]/;

/**
 * Reads a synced README's own content for signs it needs repair, without touching TUF's site.
 * Title link staleness and leftover box-art are independent signals: a README can have either, both, or neither.
 * NOTE: Box-drawing characters inside a fenced code block are the FIXED, intended output (readme.js wraps TUF's own hand-typed ASCII tables in one), not garbling. Only a box-drawing character sitting directly in prose, never fenced, is the pre-fix symptom, so fenced regions are stripped before the check.
 */
export function detectReadmeIssues(content) {
  const reasons = [];
  const text = content || '';
  const titleMatch = text.match(/^# \[.*?\]\((.*?)\)/);
  const url = titleMatch ? titleMatch[1] : '';
  if (isStaleUrl(url)) reasons.push('stale_link');
  const outsideFences = text.replace(/```[\s\S]*?```/g, '');
  if (BOX_DRAWING_RE.test(outsideFences)) reasons.push('garbled_content');
  return { needsRepair: reasons.length > 0, reasons, url };
}
