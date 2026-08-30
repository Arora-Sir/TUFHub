/**
 * TUFHub GitHub REST API Uploader
 * Sequential & Conflict-Proof: 3-attempt retry loop with fresh SHA resolution
 * Author: Mohit Arora (@Arora-Sir)
 */

import { encode } from '../util.js';

function ghHeaders(token, extra = {}) {
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    ...extra
  };
}

// Per-hook branch memo so a repeat commitFiles() call in the same session
// doesn't re-probe default_branch/main/master every time.
const branchCache = new Map();

async function resolveDefaultBranch(token, hook) {
  if (branchCache.has(hook)) return branchCache.get(hook);
  try {
    const res = await fetch(`https://api.github.com/repos/${hook}`, { headers: ghHeaders(token) });
    if (res.ok) {
      const json = await res.json();
      if (json.default_branch) {
        branchCache.set(hook, json.default_branch);
        return json.default_branch;
      }
    }
  } catch (e) {}
  return null;
}

async function getRef(token, hook, branch) {
  const res = await fetch(`https://api.github.com/repos/${hook}/git/ref/heads/${branch}`, { headers: ghHeaders(token) });
  if (!res.ok) return null;
  const json = await res.json();
  return json.object ? json.object.sha : null;
}

/**
 * Resolves the branch to commit against, trying (in order) the repo's real
 * default_branch, then a bare "main"/"master" probe if that lookup fails -
 * mirrors the fallback stats.js already uses on the read side for repo-tree
 * reconciliation.
 */
async function resolveBranchAndHead(token, hook) {
  const candidates = [];
  const known = await resolveDefaultBranch(token, hook);
  if (known) candidates.push(known);
  if (!candidates.includes('main')) candidates.push('main');
  if (!candidates.includes('master')) candidates.push('master');

  for (const branch of candidates) {
    const headSha = await getRef(token, hook, branch);
    if (headSha) {
      branchCache.set(hook, branch);
      return { branch, headSha };
    }
  }
  throw new Error('Could not resolve a branch HEAD for this repository.');
}

// Growing + jittered backoff, not a flat interval - under genuine concurrent
// writers (a second tab syncing while the popup deletes a folder, confirmed
// to actually happen via a real "Ref Update Conflict" failure), repeated
// writers retrying at the exact same flat interval keep re-colliding on the
// same branch ref instead of spreading out.
function retryBackoffMs(attempt) {
  return 300 * (attempt + 1) + Math.floor(Math.random() * 200);
}

/**
 * Commits a set of pre-built tree entries as ONE atomic git commit via the
 * Git Data API (tree -> commit -> ref update). Shared tail for both writing
 * files (commitFiles, blob-backed entries) and removing them (deleteFiles,
 * sha:null entries) - only how the entries are built differs between callers.
 *
 * @param {Array<{path: string, mode: string, type: string, sha: string|null}>} treeEntries
 * @returns {Promise<{commitSha: string, htmlUrl: string, treeSha: string}>}
 */
async function commitTreeEntries(token, hook, treeEntries, commitMessage, retries = 5) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const { branch, headSha } = await resolveBranchAndHead(token, hook);

      const commitRes = await fetch(`https://api.github.com/repos/${hook}/git/commits/${headSha}`, { headers: ghHeaders(token) });
      if (!commitRes.ok) throw new Error(`GitHub Commit Lookup Failed (${commitRes.status})`);
      const commitJson = await commitRes.json();
      const baseTreeSha = commitJson.tree.sha;

      const treeRes = await fetch(`https://api.github.com/repos/${hook}/git/trees`, {
        method: 'POST',
        headers: ghHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries })
      });
      if (!treeRes.ok) throw new Error(`GitHub Tree Create Failed (${treeRes.status})`);
      const treeJson = await treeRes.json();

      const newCommitRes = await fetch(`https://api.github.com/repos/${hook}/git/commits`, {
        method: 'POST',
        headers: ghHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ message: commitMessage, tree: treeJson.sha, parents: [headSha] })
      });
      if (!newCommitRes.ok) throw new Error(`GitHub Commit Create Failed (${newCommitRes.status})`);
      const newCommitJson = await newCommitRes.json();

      // force:false so a genuine concurrent write (second tab, manual popup
      // Sync) surfaces as a rejected ref update instead of silently
      // overwriting whatever landed on the branch in between.
      const refRes = await fetch(`https://api.github.com/repos/${hook}/git/refs/heads/${branch}`, {
        method: 'PATCH',
        headers: ghHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ sha: newCommitJson.sha, force: false })
      });

      if (refRes.ok) {
        return {
          commitSha: newCommitJson.sha,
          htmlUrl: newCommitJson.html_url || `https://github.com/${hook}/commit/${newCommitJson.sha}`,
          treeSha: treeJson.sha
        };
      }

      if (refRes.status === 409 || refRes.status === 422) {
        // GitHub's own message (e.g. "Update is not a fast forward") is worth
        // keeping - the bare status code alone can't distinguish a genuine
        // non-fast-forward race from other 409/422 causes. Body read is
        // best-effort: never let a parse failure mask the real conflict.
        let detail = '';
        try {
          const errJson = await refRes.json();
          if (errJson && errJson.message) detail = `: ${errJson.message}`;
        } catch (e) {}
        console.warn(`[TUFHub Debug] Ref update conflict on ${branch} (attempt ${attempt + 1}/${retries}). Retrying against new HEAD...`);
        lastErr = new Error(`GitHub Ref Update Conflict (${refRes.status})${detail}`);
        await new Promise(r => setTimeout(r, retryBackoffMs(attempt)));
        continue;
      }

      throw new Error(`GitHub Ref Update Failed (${refRes.status})`);
    } catch (e) {
      lastErr = e;
      if (attempt < retries - 1) {
        await new Promise(r => setTimeout(r, retryBackoffMs(attempt)));
      }
    }
  }

  throw lastErr || new Error(`commitTreeEntries failed after ${retries} retries`);
}

/**
 * Commits any number of files as ONE atomic git commit via the Git Data API
 * (blobs -> tree -> commit -> ref update), instead of one Contents-API PUT
 * per file (which each create their own commit). Blobs are content-addressed
 * so no per-file "current sha" lookup is needed before writing.
 *
 * @param {Array<{path: string, content: string}>} files
 * @returns {Promise<{commitSha: string, htmlUrl: string, treeSha: string}>}
 */
async function createBlob(token, hook, file, retries) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const blobRes = await fetch(`https://api.github.com/repos/${hook}/git/blobs`, {
        method: 'POST',
        headers: ghHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ content: encode(file.content), encoding: 'base64' })
      });
      if (!blobRes.ok) throw new Error(`GitHub Blob Create Failed (${blobRes.status}) for ${file.path}`);
      const blobJson = await blobRes.json();
      return blobJson.sha;
    } catch (e) {
      lastErr = e;
      if (attempt < retries - 1) await new Promise(r => setTimeout(r, 300));
    }
  }
  throw lastErr;
}

export async function commitFiles(token, hook, files, commitMessage, retries = 5) {
  if (!files || files.length === 0) {
    throw new Error('commitFiles called with no files.');
  }

  // Own retry loop, independent of commitTreeEntries' ref-conflict retries below -
  // a failed blob upload is a transient network issue, not a concurrent-write
  // conflict, and shouldn't be silently unretried just because this step now
  // lives outside the shared tree/commit/ref loop.
  const blobShas = await Promise.all(files.map(file => createBlob(token, hook, file, retries)));

  const treeEntries = files.map((file, i) => ({ path: file.path, mode: '100644', type: 'blob', sha: blobShas[i] }));
  return commitTreeEntries(token, hook, treeEntries, commitMessage, retries);
}

/**
 * Deletes a set of exact blob paths in ONE atomic git commit. GitHub's Git
 * Trees API removes a path from the tree when its entry carries sha: null -
 * no blob-creation or per-file "current sha" lookup needed, since removal is
 * resolved against a fresh base tree fetched at commit time inside
 * commitTreeEntries.
 *
 * @param {string[]} paths
 * @returns {Promise<{commitSha: string, htmlUrl: string, treeSha: string}>}
 */
export async function deleteFiles(token, hook, paths, commitMessage, retries = 5) {
  if (!paths || paths.length === 0) {
    throw new Error('deleteFiles called with no paths.');
  }

  const treeEntries = paths.map(path => ({ path, mode: '100644', type: 'blob', sha: null }));
  return commitTreeEntries(token, hook, treeEntries, commitMessage, retries);
}

export async function uploadToGitHub(token, hook, path, content, commitMessage, sha = '', retries = 3) {
  const url = `https://api.github.com/repos/${hook}/contents/${path}`;
  let currentSha = sha;

  for (let attempt = 0; attempt < retries; attempt++) {
    // 1. Fetch latest SHA from GitHub API before every attempt to guarantee fresh branch HEAD
    try {
      const getRes = await fetch(url, {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json'
        }
      });
      if (getRes.ok) {
        const getJson = await getRes.json();
        currentSha = getJson.sha;
      } else if (getRes.status === 404) {
        // File does not exist at this path yet (new path after topic re-routing).
        // Clear any stale SHA so GitHub creates the file fresh instead of failing with 422.
        currentSha = '';
      }
    } catch (e) {}

    const bodyData = {
      message: commitMessage,
      content: encode(content)
    };
    if (currentSha) {
      bodyData.sha = currentSha;
    }

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(bodyData)
    });

    if (response.ok) {
      const json = await response.json();
      return {
        contentSha: json.content ? json.content.sha : '',
        commitSha: json.commit ? json.commit.sha : '',
        htmlUrl: json.commit ? json.commit.html_url : (json.content ? json.content.html_url : '')
      };
    }

    // Handle 409 Conflict / 422 Unprocessable Content with backoff retry
    if (response.status === 409 || response.status === 422) {
      console.warn(`[TUFHub Debug] HTTP ${response.status} on ${path} (attempt ${attempt + 1}/${retries}). Retrying...`);
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    throw new Error(`GitHub Upload Failed (${response.status})`);
  }

  throw new Error(`GitHub Upload Failed after ${retries} retries`);
}
