/**
 * TUFHub GitHub REST API Uploader
 * Author: Mohit Arora (@Arora-Sir)
 */

import { encode, decode } from '../util.js';
import { getStats, updateStats } from './stats.js';

export async function uploadToGitHub(token, hook, path, content, commitMessage, sha = '') {
  const url = `https://api.github.com/repos/${hook}/contents/${path}`;
  
  const bodyData = {
    message: commitMessage,
    content: encode(content)
  };
  if (sha) {
    bodyData.sha = sha;
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

  if (response.status === 409) {
    // 409 Conflict: fetch latest SHA from GitHub API and retry once
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
