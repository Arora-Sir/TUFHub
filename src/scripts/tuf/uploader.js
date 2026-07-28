/**
 * TUFHub GitHub REST API Uploader
 * Conflict-Proof: Always fetches latest file SHA before updating!
 * Author: Mohit Arora (@Arora-Sir)
 */

import { encode } from '../util.js';

export async function uploadToGitHub(token, hook, path, content, commitMessage, sha = '') {
  const url = `https://api.github.com/repos/${hook}/contents/${path}`;
  let currentSha = sha;

  // 1. If SHA not provided, check if file already exists on GitHub to retrieve SHA
  if (!currentSha) {
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
      }
    } catch (e) {}
  }

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

  // 2. 409/422 Conflict Recovery: Fetch fresh SHA and retry
  if (response.status === 409 || response.status === 422) {
    console.warn(`[TUFHub Debug] HTTP ${response.status} on ${path}. Fetching fresh SHA to retry...`);
    const getRes = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json'
      }
    });

    if (getRes.ok) {
      const getJson = await getRes.json();
      bodyData.sha = getJson.sha;
      const retryRes = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(bodyData)
      });
      if (!retryRes.ok) {
        throw new Error(`GitHub Upload Failed (${retryRes.status})`);
      }
      const retryJson = await retryRes.json();
      return retryJson.content.sha;
    }
  }

  if (!response.ok) {
    throw new Error(`GitHub Upload Failed (${response.status})`);
  }

  const json = await response.json();
  return json.content.sha;
}
