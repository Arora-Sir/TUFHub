/**
 * TUFHub GitHub OAuth Authorizer
 * Author: Mohit Arora (@Arora-Sir)
 */

export const DEFAULT_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';

export async function requestGitHubAuth(customClientId = '', customClientSecret = '') {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'LAUNCH_GITHUB_OAUTH',
        clientId: customClientId || DEFAULT_CLIENT_ID,
        clientSecret: customClientSecret
      },
      (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }

        if (response && response.success) {
          resolve(response);
        } else {
          reject(new Error(response?.error || 'OAuth authentication failed'));
        }
      }
    );
  });
}
