/**
 * TUFHub Problem README.md Builder
 * HTML -> Clean Markdown Parser for TUF+ Problem Statements
 * Author: Mohit Arora (@Arora-Sir)
 */

export function buildProblemReadme(data) {
  const { title, difficulty, description, url } = data;
  const diffStr = difficulty || 'Medium';
  const problemUrl = url || 'https://takeuforward.org/plus';

  const cleanDesc = convertTufHtmlToMarkdown(description);
  const badgeColor = diffStr.toLowerCase().includes('easy')
    ? '22c55e'
    : diffStr.toLowerCase().includes('hard')
    ? 'ef4444'
    : 'eab308';

  return `# [${title}](${problemUrl})

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

function convertTufHtmlToMarkdown(html) {
  if (!html || html.trim().length === 0) {
    return 'Problem description available on TakeUForward (TUF+).';
  }

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Remove unwanted UI buttons, hints, accordions, titles, footers, quizzes
    const junkSelectors = [
      'button',
      'svg',
      '.difficulty-badge',
      '[class*="accordion"]',
      '[class*="hints"]',
      '[class*="sticky"]',
      '[class*="pointer-events-none"]',
      '[class*="quiz"]',
      '[class*="your-turn"]',
      '[class*="interactive"]',
      'h1'
    ];
    junkSelectors.forEach(sel => {
      doc.querySelectorAll(sel).forEach(el => el.remove());
    });

    // Remove text matching "Hints", "Doubts", "Follow-ups", "Fun Facts", "Extras", "Now your turn"
    doc.querySelectorAll('*').forEach(el => {
      const text = (el.innerText || el.textContent || '').trim();
      if (/^(Hints|Frequently Occurring Doubts|Interview Follow-ups|Fun Facts|Extras|Company|Similar Problems|Now your turn!|Pick your answer)/i.test(text)) {
        el.remove();
      }
    });

    let body = doc.body;

    // Convert Examples
    body.querySelectorAll('.tuf-vstack').forEach(vstack => {
      const headerElem = vstack.querySelector('.tuf-text-14, h3, h4, .tuf-header');
      const rawHeader = headerElem ? (headerElem.innerText || headerElem.textContent).trim() : '';
      const headerText = rawHeader.replace(/<[^>]*>/g, '');

      if (/Example\s*\d+/i.test(headerText)) {
        const exBox = vstack.querySelector('.tuf-example');
        if (exBox) {
          const exHtml = exBox.innerHTML
            .replace(/<strong>Input\s*:?<\/strong>\s*:?/gi, '\n**Input:** ')
            .replace(/<strong>Output\s*:?<\/strong>\s*:?/gi, '\n**Output:** ')
            .replace(/<strong>Explanation\s*:?<\/strong>\s*:?/gi, '\n**Explanation:** ');
          
          vstack.innerHTML = `<h3>${headerText}</h3><div>${exHtml}</div>`;
        }
      } else if (/Constraints/i.test(headerText)) {
        const constraintBox = vstack.querySelector('.tuf-dark-content-box, ul');
        const cHtml = constraintBox ? constraintBox.innerHTML : vstack.innerHTML;
        vstack.innerHTML = `<h3>Constraints</h3><div>${cHtml}</div>`;
      }
    });

    let markdown = body.innerHTML;

    // Convert HTML tags to Markdown
    markdown = markdown
      .replace(/<h3>(.*?)<\/h3>/gi, '\n\n### $1\n\n')
      .replace(/<sup>(.*?)<\/sup>/gi, '^$1')
      .replace(/<sub>(.*?)<\/sub>/gi, '_$1')
      .replace(/<strong>\s*(.*?)\s*<\/strong>/gi, '**$1**')
      .replace(/<b>\s*(.*?)\s*<\/b>/gi, '**$1**')
      .replace(/<em>\s*(.*?)\s*<\/em>/gi, '*$1*')
      .replace(/<i>\s*(.*?)\s*<\/i>/gi, '*$1*')
      .replace(/<code>(.*?)<\/code>/gi, '`$1`')
      .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
      .replace(/<\/?ul[^>]*>/gi, '\n')
      .replace(/<\/?ol[^>]*>/gi, '\n')
      .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
      .replace(/<div[^>]*>/gi, '')
      .replace(/<\/div>/gi, '\n')
      .replace(/<span[^>]*>/gi, '')
      .replace(/<\/span>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"');

    // Clean up bold spacing artifacts (**word ** -> **word**)
    markdown = markdown
      .replace(/\*\*\s+(.*?)\s*\*\*/g, ' **$1**')
      .replace(/\*\*\s*(.*?)\s+\*\*/g, '**$1** ')
      .replace(/\*\*\s*:\s*\*\*/g, ':**')
      .replace(/\*\*(Input|Output|Explanation):\*\*\s*:/gi, '**$1:**');

    // Fix constraints exponent formatting (105 -> 10^5, -104 -> -10^4)
    markdown = markdown
      .replace(/\b10([3456789])\b/g, '10^$1')
      .replace(/\b-10([3456789])\b/g, '-10^$1');

    // Remove remaining quiz leftovers
    markdown = markdown
      .replace(/Now your turn![\s\S]*?(Constraints|Complexity|$)/gi, '\n\n$1')
      .replace(/Pick your answer[\s\S]*?(Constraints|Complexity|$)/gi, '\n\n$1');

    // Clean up double newlines
    markdown = markdown.replace(/\n\s*\n\s*\n+/g, '\n\n').trim();

    return markdown.length > 20 ? markdown : 'Problem description available on TakeUForward (TUF+).';
  } catch (e) {
    return html.replace(/<[^>]+>/g, '').trim();
  }
}
