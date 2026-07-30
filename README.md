<p align="center">
  <img src="src/assets/icons/icon128.png" width="96" height="96" alt="TUFHub Logo" />
</p>

<h1 align="center">
  TUFHub
  <br>
  <sub>Automatically sync your TakeUForward (TUF+) solutions to GitHub.</sub>
</h1>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/tufhub-takeuforward-githu/fbbjinonammckffpfmhicgdcfgodfnge" target="_blank">
    <img src="https://img.shields.io/badge/Chrome_Web_Store-Available_Now-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Available in Chrome Web Store" />
  </a>
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/tufhub-takeuforward-githu/fbbjinonammckffpfmhicgdcfgodfnge" target="_blank">
    <img src="https://img.shields.io/badge/Chrome_Web_Store-v1.0.0-blue.svg?logo=googlechrome" alt="Chrome Web Store" />
  </a>
  <a href="https://github.com/Arora-Sir/TUFHub/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" />
  </a>
  <img src="https://img.shields.io/badge/manifest-v3-green.svg" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/platform-Chrome-yellow.svg" alt="Chrome Extension" />
</p>

> 📘 **Interactive Development Blueprint**: Explore the complete 12-hour architectural blueprint, manifest specs, asset design pipeline, and bug resolution log at [Chrome Extension Blueprint](https://arora-sir.github.io/Chrome_Extension_Blueprint.html).

---

## 🚀 What is TUFHub?

TUFHub is a Chrome Extension that automatically syncs your **accepted solutions** from [TakeUForward (TUF+)](https://takeuforward.org/plus?affiliate=arorasir) to your GitHub repository in real time: the exact moment you pass 100% test cases.

No manual copying. No drag & drop. Just solve, submit, and your solution lands on GitHub instantly.

---

## 📥 Direct 1-Click Installation

### Option 1: Official Chrome Web Store (Recommended)
Click below to install TUFHub directly into Google Chrome with automatic background updates:

<p align="left">
  <a href="https://chromewebstore.google.com/detail/tufhub-takeuforward-githu/fbbjinonammckffpfmhicgdcfgodfnge" target="_blank">
    <img src="https://img.shields.io/badge/Add_to_Chrome-Install_TUFHub-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Add to Chrome - Install TUFHub" />
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
- **Multi-Category Organization**: Categorizes problems under DSA, SQL, Aptitude, and Mock Tests.
- **Smart Folder Hierarchy**: Dynamically resolves subtopics and problem slugs.
- **Problem Statement README**: Generates per-problem `README.md` with difficulty & complexity analysis.
- **Master Repository Index**: Maintains a master `README.md` index table sorted by category & difficulty.
- **Live Extension Popup**: Tracks Solved, Easy, Medium, Hard counts with a 1-click **↻ Sync** button.
- **Conflict-Safe Commits**: Sequential queue prevents Git 409 commit conflicts.

---

## 📁 Repository Folder Structure

Your solutions repository is automatically organized like this:

```
TUF-Solutions/
├── DSA/
│   ├── Arrays/0001-set-matrix-zeroes/ (solution.cpp, README.md)
│   ├── Linked-List/
│   ├── Recursion/
│   └── ...
├── SQL/
│   └── Joins/
├── Aptitude/
├── Mock-Tests/
└── README.md   <-- Master Index
```

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

**Q: My stats show 0 after reinstalling.**  
Click the **↻ Sync** button in the popup to re-scan your repository and restore your stats instantly.

**Q: Can I use an existing repository?**  
Yes. Enter the name of your existing repo during setup; TUFHub will connect to it and scan existing solutions.

**Q: Is this extension affiliated with TakeUForward?**  
No. This is an independent open-source tool and is not officially affiliated with TakeUForward.
</details>

---

## 📘 Architecture & Development Blueprint

For an exhaustive 12-hour session transcript breakdown, Manifest V3 background service worker architecture, visual asset pipeline, and technical bug fix ledger, visit the interactive blueprint:

👉 **[View Full Chrome Extension Development Blueprint](https://arora-sir.github.io/Chrome_Extension_Blueprint.html)**

---

## ⭐ Support & Community

If TUFHub helps you stay consistent on your coding journey, please consider supporting the project:

- 🎓 **Enroll in TUF+**: Get the official course via [TakeUForward (TUF+)](https://takeuforward.org/plus?affiliate=arorasir)
- 🛒 **Chrome Web Store**: Rate and review [TUFHub on Chrome Web Store](https://chromewebstore.google.com/detail/tufhub-takeuforward-githu/fbbjinonammckffpfmhicgdcfgodfnge)
- ⭐ **Star this repository**: Give [TUFHub a star on GitHub](https://github.com/Arora-Sir/TUFHub)
- ☕ **Donate**: Support via [PayPal](https://paypal.me/arorasir) or UPI (`mohit1998arora@yescred`)

---

<p align="center">
  Crafted with ❤️ for Problem Solvers by <a href="https://github.com/Arora-Sir">Mohit Arora</a>
</p>
