/**
 * TUFHub Problem README.md Builder
 * Author: Mohit Arora (@Arora-Sir)
 */

export function buildProblemReadme(data) {
  const { title, difficulty, description, url } = data;
  const diffStr = difficulty || 'Medium';
  const problemUrl = url || 'https://takeuforward.org/plus';

  const cleanDesc = sanitizeDescriptionHTML(description);
  const badgeColor = diffStr.toLowerCase().includes('easy')
    ? '22c55e'
    : diffStr.toLowerCase().includes('hard')
    ? 'ef4444'
    : 'eab308';

  return `<h1><a href="${problemUrl}">${title}</a></h1>

![Difficulty: ${diffStr}](https://img.shields.io/badge/Difficulty-${diffStr}-${badgeColor}?style=for-the-badge)

---

## 📝 Problem Statement

${cleanDesc}

---

## 💡 Complexity Analysis

- **Time Complexity:** $\\mathcal{O}(N)$
- **Space Complexity:** $\\mathcal{O}(1)$

---

> Auto-synced using [TUFHub](https://github.com/Arora-Sir/TUFHub) - TakeUForward (TUF+) Solutions
`;
}

function sanitizeDescriptionHTML(html) {
  if (!html) return 'Problem description available on TUF+.';

  // Create temporary parser in memory
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Remove tab bars, buttons, headers, discussions
    const junkSelectors = [
      '.flexlayout__tabset_tabbar_outer',
      '[class*="tabbar"]',
      'button',
      '[role="tab"]',
      '[class*="discussion"]',
      '[class*="submissions"]',
      '[class*="editorial"]'
    ];

    junkSelectors.forEach(sel => {
      doc.querySelectorAll(sel).forEach(el => el.remove());
    });

    let text = doc.body.innerHTML || doc.body.innerText || '';
    
    // Clean up excessive whitespace & lines
    text = text.replace(/<button[^>]*>.*?<\/button>/gi, '');
    text = text.replace(/(Description|Editorial|Submissions|Discussion\s*\d*)/gi, '');
    text = text.replace(/\n\s*\n\s*\n/g, '\n\n').trim();

    return text.length > 0 ? text : 'Problem statement available on TakeUForward (TUF+).';
  } catch (e) {
    return html.replace(/(Description|Editorial|Submissions|Discussion\s*\d*)/gi, '').trim();
  }
}
