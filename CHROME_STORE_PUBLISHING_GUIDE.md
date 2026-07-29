# 🚀 Chrome Web Store Publishing Guide for TUFHub

This step-by-step guide provides everything required to publish **TUFHub** on the Chrome Web Store.

---

## Package Location
- **Release Bundle:** [`TUFHub-v1.0.0.zip`](file:///C:/Users/Mohit/GeminiHub/TUFHub/TUFHub-v1.0.0.zip) (Location: `C:\Users\Mohit\GeminiHub\TUFHub\TUFHub-v1.0.0.zip`)

---

## Step 1: Open Chrome Web Store Developer Console
1. Go to the [Chrome Web Store Developer Console](https://chrome.google.com/webstore/devconsole).
2. Sign in with your Google account.
3. If this is your first time publishing, pay the one-time **$5 Google Developer Registration fee**.

---

## Step 2: Upload Extension Zip
1. Click the **"New Item"** button in the top-right corner.
2. Drag and drop [`TUFHub-v1.0.0.zip`](file:///C:/Users/Mohit/GeminiHub/TUFHub/TUFHub-v1.0.0.zip).
3. Click **Upload**.

---

## Step 3: Store Listing Information

Fill in the Store Listing tab with these pre-formatted fields:

- **Item Name:** `TUFHub - TakeUForward GitHub Sync`
- **Summary (Short Description):**  
  `Automatically sync your TakeUForward (TUF+) accepted solutions to GitHub in real-time.`
- **Category:** `Developer Tools`
- **Language:** `English`

### Detailed Description (Copy & Paste)
```text
TUFHub automatically syncs your accepted TakeUForward (TUF+) coding solutions directly to your GitHub repository in real-time.

KEY FEATURES:
- Automatic sync on Accepted verdict (100% test cases passed)
- Multi-category support: DSA, SQL, Aptitude, and Mock Tests
- Automatic folder hierarchy by topic and problem slug
- Per-problem README generation with problem statements and complexity analysis
- Auto-generated root index README with a sortable master table of all solved problems
- Stats tracking directly in the extension popup (Easy / Medium / Hard count)
- Automatic repository scanner engine to restore existing solutions stats
- Support for Personal Access Tokens (PAT) and custom OAuth Apps
- Secure: Credentials remain 100% in your local browser sandbox
```

### Store Media Assets
- **Icon (128x128):** Upload [`src/assets/icons/icon128.png`](file:///C:/Users/Mohit/GeminiHub/TUFHub/src/assets/icons/icon128.png) (Location: `C:\Users\Mohit\GeminiHub\TUFHub\src\assets\icons\icon128.png`).
- **Screenshots:** Capture 1 to 3 screenshots of your Chrome browser (resolution: **1280x800** or **640x400**) showing:
  1. TUFHub onboarding welcome page.
  2. TUFHub extension popup showing stats.
  3. A TakeUForward problem page syncing.

---

## Step 4: Privacy Practices Form

Under the **Privacy practices** tab, enter the following justifications required by Google reviewers:

### Single Purpose Justification
`Sync TakeUForward (TUF+) accepted coding solutions to the user's GitHub repository.`

### Permission Justifications
- `storage`: *Store user settings and token securely in local browser storage.*
- `identity`: *Handle OAuth 2.0 callback redirect during GitHub authorization.*
- `tabs`: *Open the onboarding welcome page upon extension installation.*
- `scripting`: *Inject submission interceptor scripts on TakeUForward pages.*
- `host_permissions` (`https://takeuforward.org/*`, `https://api.github.com/*`): *Detect problem submission verdicts on TUF+ and execute GitHub API requests to commit solution files.*

### Data Usage Certifications
- Check **"No, I do not sell user data"**.
- Check **"No, I do not use data for credit scoring or lending"**.

---

## Step 5: Submit for Review
1. Click **Save draft**, then click **Submit for review**.
2. Google review typically takes **24 to 48 hours**.
3. Once approved, Google will issue a public Webstore link (e.g. `https://chromewebstore.google.com/detail/tufhub/...`). Anyone can click that link and install TUFHub with 1 click!
