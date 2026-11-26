/**
 * TUFHub Repository Layout Rules
 * Pure decisions about where a problem folder belongs and how misplaced or duplicate folders are folded together.
 * Shared by the sync job (new submissions), reconcile (detection), and the popup (merge and repair plans), and testable in plain Node.
 * Author: Mohit Arora (@Arora-Sir)
 */

import { isContainerSegment } from '../util.js';
import { topicKey } from './router.js';

const FALLBACK_TOPIC = 'General';

function splitFolder(folderPath) {
  const parts = String(folderPath || '').split('/').filter(Boolean);
  return {
    category: parts[0] || '',
    topic: parts.length >= 3 ? parts[1] : '',
    slug: parts[parts.length - 1] || ''
  };
}

/**
 * Picks the existing topic folder spelling in a category that names the same topic as `mainTopic`, or '' when none exists.
 * An exact spelling always wins. Otherwise the spelling holding the most problems wins, so new problems join the folder that already dominates.
 * NOTE: Without this, TUF's "Querying and Filtering" became a new Querying-and-Filtering folder beside the existing Querying-And-Filtering one (BUG-020).
 */
export function existingTopicFolder(problems, category, mainTopic) {
  const wanted = topicKey(mainTopic);
  if (!wanted) return '';
  const counts = new Map();
  Object.values(problems || {}).forEach(p => {
    const { category: c, topic } = splitFolder(p && p.folderPath);
    if (c !== category || !topic || topicKey(topic) !== wanted) return;
    counts.set(topic, (counts.get(topic) || 0) + 1);
  });
  if (counts.size === 0) return '';
  if (counts.has(mainTopic)) return mainTopic;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
}

/**
 * Final folder for a routed submission, given what this browser already knows about the repo.
 * Returns { folderPath, category, mainTopic } where folderPath includes the slug.
 * NOTE: A problem already synced under its real track keeps that folder when this page could not see TUF's syllabus (saved lists, container URLs), or when the syllabus names the same topic in another spelling.
 * NOTE: A known folder under a container category or the General fallback bucket is never reused, so a misfiled problem is not locked into the wrong place.
 */
export function placeProblem(route, known, problems) {
  const slug = route.slug;
  if (known && known.folderPath) {
    const k = splitFolder(known.folderPath);
    const usable = k.topic && k.topic !== FALLBACK_TOPIC && !isContainerSegment(k.category);
    const routeIsContainer = isContainerSegment(route.category);
    if (usable && (k.category === route.category || routeIsContainer)) {
      const sameTopic = topicKey(k.topic) === topicKey(route.mainTopic);
      if (routeIsContainer || !route.topicAuthoritative || sameTopic) {
        return { folderPath: known.folderPath, category: k.category, mainTopic: k.topic };
      }
    }
  }

  const topic = existingTopicFolder(problems, route.category, route.mainTopic) || route.mainTopic;
  return { folderPath: `${route.category}/${topic}/${slug}`, category: route.category, mainTopic: topic };
}

// Lower rank is kept first: a real track folder beats the General fallback bucket, which beats a container folder.
function folderRank(folderPath) {
  const { category, topic } = splitFolder(folderPath);
  if (isContainerSegment(category)) return 2;
  if (topic === FALLBACK_TOPIC) return 1;
  return 0;
}

/**
 * Orders a duplicate group so the folder to keep comes first.
 * NOTE: Newest alone is not enough: a re-solve from a saved list was the newest copy, so the old rule kept Core-Subject/General and deleted the real SQL folder (BUG-017).
 * NOTE: Null timestamps sort last so a failed commit-date lookup is never mistaken for the oldest copy.
 */
export function mergeOrder(folders) {
  return (folders || []).slice().sort((a, b) => {
    const rank = folderRank(a.folderPath) - folderRank(b.folderPath);
    if (rank !== 0) return rank;
    if (a.lastModified == null && b.lastModified == null) return 0;
    if (a.lastModified == null) return 1;
    if (b.lastModified == null) return -1;
    return b.lastModified - a.lastModified;
  });
}

// First "Solution-N.<ext>" name (N from 2) not already taken in the target folder, compared case-insensitively.
function freeSolutionName(fileName, taken) {
  const dot = fileName.lastIndexOf('.');
  const ext = dot > 0 ? fileName.slice(dot) : '';
  const lowerTaken = new Set([...taken].map(n => n.toLowerCase()));
  for (let n = 2; ; n++) {
    const candidate = `Solution-${n}${ext}`;
    if (!lowerTaken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Plans folding a duplicate group into its kept folder: blob-sha moves for solutions the kept folder lacks, then deletes for every stale path.
 * Each folder is { folderPath, files: [full paths incl README.md], fileDetails: [{ name, sha }] without README.md, lastModified }.
 * NOTE: Identical content (same blob sha) is dropped rather than copied, and a same-name file with different content is kept as Solution-N, so a merge never loses a solution.
 * NOTE: The old plan deleted a same-name stale file without comparing content, which would have dropped the older SQL answer for exceeding-tweet-length.
 */
export function computeMergePlan(folders) {
  const ordered = mergeOrder(folders);
  const target = ordered[0];
  const targetFolder = target.folderPath;
  const nameOf = p => String(p).split('/').pop();

  const taken = new Set((target.files || []).map(nameOf));
  const keptShas = new Set((target.fileDetails || []).map(d => d.sha).filter(Boolean));
  const moves = [];
  const deletes = [];

  ordered.slice(1).forEach(stale => {
    (stale.files || []).forEach(filePath => {
      deletes.push(filePath);
      const fileName = nameOf(filePath);
      if (!fileName || fileName === 'README.md') return;
      const detail = (stale.fileDetails || []).find(d => d.name === fileName);
      if (!detail || !detail.sha || keptShas.has(detail.sha)) return;
      const name = taken.has(fileName) ? freeSolutionName(fileName, taken) : fileName;
      moves.push({ fromPath: filePath, targetPath: `${targetFolder}/${name}`, sha: detail.sha });
      taken.add(name);
      keptShas.add(detail.sha);
    });
  });

  return {
    canonicalFolder: targetFolder,
    moves,
    deletes,
    deletedFolderPaths: ordered.slice(1).map(s => s.folderPath)
  };
}

/**
 * Finds problem folders sitting in a topic folder that differs from a sibling topic folder only by letter case.
 * Returns [{ folderPath, relocateTo }]. The spelling holding the most problems is kept, ties go to the alphabetically first spelling.
 * NOTE: Grouping is case-only on purpose. Alias-equivalent names (old renamed topics) still move nothing, because Mohit approved merging case variants, not renaming topics.
 * NOTE: Folders in `skip` (already part of a duplicate group) and moves whose destination already exists are left to the duplicate merge instead.
 */
export function findTopicSplits(folderPaths, skip = new Set()) {
  const all = new Set(folderPaths || []);
  const groups = new Map();
  all.forEach(fp => {
    const parts = fp.split('/');
    if (parts.length < 3 || isContainerSegment(parts[0])) return;
    const key = `${parts[0]}/${parts[1].toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, new Map());
    const byTopic = groups.get(key);
    if (!byTopic.has(parts[1])) byTopic.set(parts[1], []);
    byTopic.get(parts[1]).push(fp);
  });

  const relocations = [];
  groups.forEach(byTopic => {
    if (byTopic.size < 2) return;
    const keep = [...byTopic.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))[0][0];
    byTopic.forEach((paths, topic) => {
      if (topic === keep) return;
      paths.forEach(fp => {
        if (skip.has(fp)) return;
        const parts = fp.split('/');
        const relocateTo = [parts[0], keep, ...parts.slice(2)].join('/');
        if (all.has(relocateTo)) return;
        relocations.push({ folderPath: fp, relocateTo });
      });
    });
  });
  return relocations.sort((a, b) => (a.folderPath < b.folderPath ? -1 : 1));
}

/**
 * Plans moving one whole problem folder (README included) to a new folder in a single commit.
 * fileDetails lists every non-README file with its blob sha. readmeSha may be empty when the folder has no README.
 */
export function relocationPlan(folderPath, fileDetails, readmeSha, relocateTo) {
  const entries = (fileDetails || []).slice();
  if (readmeSha) entries.push({ name: 'README.md', sha: readmeSha });
  return {
    moves: entries.filter(e => e.sha).map(e => ({ fromPath: `${folderPath}/${e.name}`, targetPath: `${relocateTo}/${e.name}`, sha: e.sha })),
    deletes: entries.map(e => `${folderPath}/${e.name}`)
  };
}
