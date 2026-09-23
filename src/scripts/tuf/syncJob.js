/**
 * TUFHub Sync Job Builder
 * Freezes an accepted submission into a self-contained job: destination folder, file name, code, and README are decided here, once.
 * Never reads page or tab state, so a job commits identically no matter which tab or worker runs it, or how much later.
 * Author: Mohit Arora (@Arora-Sir)
 */

import { buildProblemReadme } from './readme.js';
import { resolveHierarchy } from './router.js';
import {
  classifyDifficulty,
  deriveCodeFileName,
  deriveFileLabel,
  extensionForLanguage,
  stripUiQueryParams,
  titleFromSlug
} from '../util.js';

function newJobId() {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// A slug-derived title (no h1 or API title was available at submit time) defers to the last title this problem synced with.
function resolveTitle(payload, known, slug) {
  const raw = typeof payload.title === 'string' ? payload.title.trim() : '';
  const usable = raw && raw !== 'Unknown Problem' && raw.length <= 80 ? raw : '';
  if ((!usable || payload.titleSource === 'slug') && known && known.title) return known.title;
  return usable || titleFromSlug(slug) || 'Unknown Problem';
}

// An unreadable difficulty pill (Submissions panel open, tier not rendered yet) keeps the last known difficulty instead of downgrading it to Unspecified.
function resolveDifficulty(difficulty, known) {
  if (classifyDifficulty(difficulty) !== 'unspecified') return difficulty;
  if (known && classifyDifficulty(known.difficulty) !== 'unspecified') return known.difficulty;
  return difficulty || 'Unspecified';
}

/**
 * Builds a frozen sync job from an accepted-submission payload and the local stats cache.
 * Returns { job } for a syncable problem, or { skipReason } for pages that carry no code artifact.
 * NOTE: The problem README is left out when the payload has no description and the problem's folder already holds one.
 * NOTE: That keeps a sync from the Submissions panel (where no problem statement is rendered) from overwriting a good README with the placeholder.
 */
export function buildSyncJob(payload, stats, source) {
  const route = resolveHierarchy(payload);
  if (route.supported === false) return { skipReason: 'UNSUPPORTED_PAGE_TYPE', route };

  const slug = route.slug;
  const folderPath = `${route.folderPath}/${slug}`;
  const ext = extensionForLanguage(payload.language, route.category);
  const known = stats && stats.problems ? stats.problems[slug] || null : null;
  const title = resolveTitle(payload, known, slug);
  const difficulty = resolveDifficulty(payload.difficulty, known);
  const url = stripUiQueryParams(payload.url);
  const hasDescription = typeof payload.description === 'string' && payload.description.trim().length > 0;
  const readmeInPlace = !!(known && known.folderPath === folderPath);

  return {
    job: {
      id: newJobId(),
      token: payload.token || '',
      source,
      createdAt: Date.now(),
      url,
      slug,
      title,
      difficulty,
      category: route.category,
      mainTopic: route.mainTopic,
      subTopic: route.subTopic,
      folderPath,
      codeFileName: deriveCodeFileName(payload.tabLabel, payload.tabCount, ext),
      fileLabel: deriveFileLabel(payload.tabLabel, payload.tabCount, ext),
      code: payload.code,
      readme: !hasDescription && readmeInPlace ? null : buildProblemReadme({ title, difficulty, description: payload.description, url }),
      originTabId: null
    }
  };
}
