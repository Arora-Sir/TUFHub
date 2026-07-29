/**
 * TUFHub GitHub REST API Uploader
 * Sequential & Conflict-Proof: 3-attempt retry loop with fresh SHA resolution
 * Author: Mohit Arora (@Arora-Sir)
 */

import { encode } from '../util.js';

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
      return json.content.sha;
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
