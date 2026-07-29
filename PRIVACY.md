# Privacy Policy for TUFHub

**Effective Date:** July 29, 2026

TUFHub ("we", "our", or "us") is committed to protecting your privacy. This Privacy Policy explains how TUFHub handles your data when you use our Chrome Extension.

---

## 1. Single Purpose & Core Functionality

TUFHub is designed with a single, clear purpose: to automatically sync your accepted programming solutions from TakeUForward (TUF+) directly to your personal GitHub repository.

---

## 2. Information Collection and Storage

- **Local Storage Only:** TUFHub stores your authentication credentials (such as your Personal Access Token or OAuth Access Token) and extension settings exclusively in your browser's local sandbox (`chrome.storage.local`).
- **No Third-Party Transmission:** Your tokens, user settings, and code submissions are never sent to external servers or third-party tracking services. Communication occurs directly between your web browser and GitHub's official REST API (`api.github.com`).
- **No Personal Identifiable Information (PII):** We do not collect names, email addresses, payment details, browsing history, or personal tracking metrics.

---

## 3. Permissions Used & Justification

- **`storage`**: Used to save extension configuration, authentication tokens, and sync status locally in your browser.
- **`tabs`**: Used to verify if the current active tab is a TakeUForward problem page.
- **`scripting`**: Used to inject network monitoring scripts into TakeUForward problem pages to capture judge verdict events in real-time.
- **`host_permissions` (`takeuforward.org`, `github.com`, `api.github.com`)**: Required to listen for accepted submission verdicts on TakeUForward and push code files to your target GitHub repository.

---

## 4. Third-Party Services

TUFHub interacts exclusively with:
- **TakeUForward (TUF+)**: `https://takeuforward.org/` (Source of problem submissions)
- **GitHub REST API**: `https://api.github.com/` (Destination repository storage)

No data is sold, rented, transferred, or shared with third parties or used for commercial advertising or credit scoring.

---

## 5. User Control and Data Deletion

You retain full control over your data at all times:
- You can disconnect your GitHub account or delete your stored Personal Access Token instantly by clicking **Disconnect** in the extension popup menu.
- Uninstalling the extension completely removes all locally stored preferences and tokens from your browser.

---

## 6. Open Source & Contact

TUFHub is an open-source project licensed under the MIT License. You can review the complete source code or raise questions on GitHub:

- **GitHub Repository:** [https://github.com/Arora-Sir/TUFHub](https://github.com/Arora-Sir/TUFHub)
- **Developer Profile:** [https://github.com/Arora-Sir](https://github.com/Arora-Sir)
