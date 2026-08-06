<p align="center">
  <img src="src/assets/icons/icon128.png" width="96" height="96" alt="TUFHub Logo" />
</p>

<h1 align="center">
  TUFHub
  <br>
  <sub>Automatically sync your TakeUForward (TUF+) solutions to GitHub.</sub>
</h1>

<p align="center">
  <a href="https://tufhub.mohitarora.me" target="_blank" rel="noopener noreferrer">
    <img src="https://img.shields.io/badge/Website-tufhub.mohitarora.me-0284c7?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Official Website" />
  </a>
  <a href="https://chromewebstore.google.com/detail/tufhub/fbbjinonammckffpfmhicgdcfgodfnge" target="_blank" rel="noopener noreferrer">
    <img src="https://img.shields.io/badge/Chrome_Web_Store-Available_Now-1d4ed8?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Available in Chrome Web Store" />
  </a>
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/tufhub/fbbjinonammckffpfmhicgdcfgodfnge" target="_blank" rel="noopener noreferrer">
    <img src="https://img.shields.io/badge/Chrome_Web_Store-v1.3.0-1d4ed8.svg?logo=googlechrome" alt="Chrome Web Store" />
  </a>
  <a href="https://github.com/Arora-Sir/TUFHub/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" />
  </a>
  <img src="https://img.shields.io/badge/manifest-v3-green.svg" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/platform-Chrome-yellow.svg" alt="Chrome Extension" />
</p>

---

## 🚀 What is TUFHub?

TUFHub is a Chrome Extension that automatically syncs your **accepted solutions** from <a href="https://takeuforward.org/plus?affiliate=arorasir" target="_blank" rel="noopener noreferrer">TakeUForward (TUF+)</a> to your GitHub repository in real time. Inspired by <a href="https://github.com/QasimWani/LeetHub" target="_blank" rel="noopener noreferrer">LeetHub</a>, it brings zero-friction automated GitHub sync specifically to TakeUForward: solve, submit, and your solution lands on GitHub instantly.

---

## 📥 Direct 1-Click Installation

### Option 1: Official Chrome Web Store (Recommended)
Click below to install TUFHub directly into Google Chrome with automatic background updates:

<p align="left">
  <a href="https://chromewebstore.google.com/detail/tufhub/fbbjinonammckffpfmhicgdcfgodfnge" target="_blank" rel="noopener noreferrer">
    <img src="https://img.shields.io/badge/Add_to_Chrome-Install_TUFHub-0284c7?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Add to Chrome - Install TUFHub" />
  </a>
</p>

### Option 2: Manual Developer Mode (Unpacked Build)
1. Clone or download this repository:
   ```bash
   git clone https://github.com/Arora-Sir/TUFHub.git
   cd TUFHub && npm install && npm run build
   ```
2. Open Chrome → navigate to `chrome://extensions` → enable **Developer mode**.
3. Click **Load unpacked** and select the generated `dist/` directory.

---

## 📸 Screenshots & Showcase

<p align="center">
  <img src="src/assets/readme_screenshots/popup_dashboard.png?v=5" width="900" alt="TUFHub Extension Popup Dashboard" />
</p>

### 📁 Master Solutions Repository Index
Auto-maintains a structured `README.md` at the root of your solutions repository with real-time stats and topic badges.

<p align="center">
  <img src="src/assets/readme_screenshots/master_index.png?v=5" width="900" alt="Master Solutions Index Table" />
</p>

### ⚡ Automated Solution Commits
Commits code solutions with clean folder hierarchy, language extensions, and formatted problem statements.

<p align="center">
  <img src="src/assets/readme_screenshots/github_sync.png?v=5" width="900" alt="GitHub Synced Code Preview" />
</p>

---

## ✨ Features

- **Auto-Sync on 100% Pass**: Only commits accepted solutions; ignores failing attempts.
- **Multi-Tab Solution Sync**: Keep separate TUF+ tabs for bruteforce/better/optimal? Each open tab (2+) syncs as its own file instead of overwriting the last - `Solution-1.ext`/`Solution-2.ext` for default tabs, or your own tab name (e.g. `Optimal.java`) if you renamed it.
- **Verifiable Sync Proof**: Success toasts show the short commit SHA and a clickable `[View commit]` link directly to GitHub.
- **Toolbar Status Badges**: Toolbar icon shows Green `OK` on success, Red `!` on error, and Amber count for queued offline syncs.
- **Multi-Category Organization**: Categorizes problems under DSA, SQL, Aptitude, and Mock Tests.
- **Smart Folder Hierarchy**: Dynamically resolves subtopics and problem slugs.
- **SPA Route Protection**: Automatically re-arms content scripts on TUF+ single-page navigation (no manual refresh needed).
- **Problem Statement README**: Generates per-problem `README.md` with difficulty and complexity analysis.
- **Master Repository Index**: Maintains a master `README.md` index table sorted by category and difficulty.
- **Live Extension Popup**: Tracks Solved, Easy, Medium, Hard counts with a 1-click **Sync** button that reconciles against the actual repository tree - if you delete a problem folder on GitHub, Sync removes it from the master index too, not just from your local view.
- **Sync Health Panel**: Real-time tab hook status, last successful commit link, and a 50-event diagnostic log in the popup.
- **Conflict-Safe Commits**: Sequential queue prevents Git 409 commit conflicts.
- **Offline Queue**: Queues syncs when offline and flushes automatically when the connection is restored.

---

## 📁 Repository Folder Structure

Your solutions repository is automatically organized like this:

```
TUF-Solutions/
├── DSA/
│   ├── Arrays/0001-set-matrix-zeroes/ (solution.cpp, README.md)
│   ├── Linked-List/
│   ├── Recursion/
│   │   └── 0012-letter-combinations/ (Solution-1.java, Optimal.java, README.md)
│   └── ...
├── SQL/
│   └── Joins/
├── Aptitude/
├── Mock-Tests/
└── README.md   <-- Master Index
```

> Problems solved with a single tab keep the plain `solution.<ext>` naming above. A
> problem folder only gets multiple files once you've used 2+ tabs in TUF+ for it.

---

## 💻 Supported Languages

| **C++** (`.cpp`) | **Java** (`.java`) | **Python** (`.py`) | **JavaScript** (`.js`) | **C#** (`.cs`) | **Go** (`.go`) | **SQL** (`.sql`) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

---

## ⚡ Quick Setup Guide

### 1. Connection
- **Personal Access Token (Recommended)**: Click the pre-configured link in the onboarding wizard to generate a PAT with `repo` scope, paste it, and save.

<details>
<summary><b>OAuth App Setup (Advanced)</b></summary>

1. Click **Register OAuth App on GitHub** (pre-fills app name and callback URL).
2. Generate Client ID & Client Secret, paste them into TUFHub, and click **Launch GitHub OAuth Flow**.
</details>

### 2. Start Syncing!
Go to [TakeUForward TUF+](https://takeuforward.org/plus?affiliate=arorasir), solve any problem, and hit **Submit**. Your solution will land on GitHub automatically!

---

## 🔒 Privacy & Security

- **Direct Local Communication**: Data is transmitted strictly between your browser and `api.github.com`.
- **Local Credential Storage**: Tokens are stored securely in `chrome.storage.local` and never sent to third-party servers.
- **Zero Telemetry**: No analytics, tracking, or external logging.

---

<details>
<summary><b>📂 Developer Setup & Project Architecture</b></summary>

### Build Commands
```bash
npm install     # Install dependencies
npm run build   # Production Webpack 5 build (outputs to dist/)
npm run dev     # Development build with watch mode
```

### Directory Structure
```
TUFHub/
├── src/
│   ├── manifest.json          # Chrome Extension Manifest V3
│   ├── popup.html             # Extension popup UI
│   ├── welcome.html           # Onboarding wizard
│   ├── css/popup.css          # Shared styles
│   └── scripts/
│       ├── popup.js           # Popup controller
│       ├── welcome.js         # Onboarding wizard logic
│       ├── background.js      # Service worker & OAuth
│       └── tuf/               # Network interceptor, README builders & GitHub API uploader
├── webpack.config.js
└── package.json
```
</details>

---

<details>
<summary><b>❓ Frequently Asked Questions (FAQ)</b></summary>

<br>

**Q: Will it sync if I only pass some test cases?**  
No. TUFHub syncs strictly when 100% test cases pass.

**Q: What if I submit the same problem in another language?**  
TUFHub adds the new language file alongside the existing solution in the same folder and updates the master index.

**Q: I keep separate tabs for bruteforce/optimal in TUF+. Will they overwrite each other?**  
No. Once a problem has 2+ open tabs in TUF+, each accepted submission syncs as its own file - `Solution-1.ext`/`Solution-2.ext` for default tab names, or your own renamed tab (e.g. `Optimal.java`) verbatim. A problem solved with just one tab keeps the plain `solution.<ext>` naming.

**Q: My stats show 0 after reinstalling.**  
Click the **Sync** button in the popup to re-scan your repository and restore your stats instantly.

**Q: I deleted a problem folder on GitHub. Will the master README update?**  
Yes - click **Sync**. It reads the actual current state of your repository (not just your local cache) and rewrites the master index to match, removing anything no longer there. There's a short cooldown between syncs, and it only commits when something has genuinely changed, so repeated clicks won't spam your commit history.

**Q: Can I use an existing repository?**  
Yes. Enter the name of your existing repo during setup; TUFHub will connect to it and scan existing solutions.

**Q: The popup shows "Messaging check failed" after a Chrome update or extension reload.**  
This happens when the TUF+ tab was open before the extension was updated and its internal messaging channels are now stale. Simply refresh the TUF+ tab (F5) to reload the new content script. The popup will immediately show green once the fresh script is running.

**Q: The sync toast appeared but the commit link shows an older SHA.**  
The sync committed successfully. The older SHA in storage is from a previous sync before the extension was reloaded. Refresh the TUF+ tab and the next sync will show the correct new SHA.

**Q: Is this extension affiliated with TakeUForward?**  
No. This is an independent open-source tool and is not officially affiliated with TakeUForward.
</details>

---

## 🙏 Acknowledgements & Inspiration

TUFHub is inspired by open-source submission sync extensions:

- **[LeetHub](https://github.com/QasimWani/LeetHub)** ([QasimWani](https://github.com/QasimWani)) - Original LeetCode sync tool.
- **[LeetHub 2.0](https://github.com/arunbhardwaj/LeetHub-2.0)** ([arunbhardwaj](https://github.com/arunbhardwaj)) - Manifest V3 architecture reference.

TUFHub adapts these concepts for TakeUForward (TUF+) with multi-category support, network interception, and automated README indexing.

---

## ⭐ Support & Community

If TUFHub helps you stay consistent on your coding journey, please consider supporting the project:

- 🎓 **Enroll in TUF+**: Get the official course via <a href="https://takeuforward.org/plus?affiliate=arorasir" target="_blank" rel="noopener noreferrer">TakeUForward (TUF+)</a>
- 🌐 **Official Website**: Visit <a href="https://tufhub.mohitarora.me" target="_blank" rel="noopener noreferrer">tufhub.mohitarora.me</a>
- 🛒 **Chrome Web Store**: Rate and review <a href="https://chromewebstore.google.com/detail/tufhub/fbbjinonammckffpfmhicgdcfgodfnge" target="_blank" rel="noopener noreferrer">TUFHub on Chrome Web Store</a>
- ⭐ **Star this repository**: Give <a href="https://github.com/Arora-Sir/TUFHub" target="_blank" rel="noopener noreferrer">TUFHub a star on GitHub</a>
- ☕ **Donate**: Support via <a href="https://paypal.me/arorasir" target="_blank" rel="noopener noreferrer">PayPal</a> or UPI (`mohit1998arora@yescred`)

---

<p align="center">
  Crafted with ❤️ for Problem Solvers by <a href="https://github.com/Arora-Sir" target="_blank" rel="noopener noreferrer">Mohit Arora</a>
</p>
