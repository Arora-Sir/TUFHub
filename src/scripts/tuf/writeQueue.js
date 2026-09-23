/**
 * TUFHub GitHub Write Serialization (background service worker only)
 * Author: Mohit Arora (@Arora-Sir)
 */

// NOTE: Serializes every repository mutation (sync jobs, folder deletions, tree reconciliation) through a single FIFO promise chain.
// NOTE: Concurrent writers would race GitHub branch ref updates and fail with HTTP 409 or 422 conflicts.
// NOTE: The chain is module-scoped and resets when the MV3 worker sleeps, which is safe because pending sync jobs persist in chrome.storage, not here.
let ghWriteQueue = Promise.resolve();

export function enqueueGitHubWrite(taskFn) {
  const result = ghWriteQueue.then(taskFn, taskFn);
  ghWriteQueue = result.catch(() => {}); // never let a rejection poison the chain for the next caller
  return result;
}
