/**
 * TUFHub Problem README.md Builder
 * HTML -> Clean Markdown Parser for TUF+ Problem Statements
 * Author: Mohit Arora (@Arora-Sir)
 */

import { classifyDifficulty } from '../util.js';

export function buildProblemReadme(data) {
  const { title, difficulty, description, url } = data;
  const diffStr = difficulty || 'Unspecified';
  const problemUrl = url || 'https://takeuforward.org/pricing?affiliate=arorasir';

  const cleanDesc = convertTufHtmlToMarkdown(description);
  const bucket = classifyDifficulty(diffStr);
  const badgeColor = bucket === 'easy' ? '22c55e' : bucket === 'hard' ? 'ef4444' : bucket === 'unspecified' ? '6b7280' : 'eab308';

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

<p align="center">
  Generated with ❤️ by <a href="https://github.com/Arora-Sir">Mohit Arora</a> &nbsp;|&nbsp; Practice on <a href="https://takeuforward.org/pricing?affiliate=arorasir">TakeUForward (TUF+)</a> &nbsp;|&nbsp; ⭐ <a href="https://github.com/Arora-Sir/TUFHub">Star TUFHub on GitHub</a>
</p>
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
      if (/^(Hints|Frequently Occurring Doubts|Interview Follow-up|Fun Facts|Extras|Company|Similar Problems|Now your turn!|Pick your answer)/i.test(text)) {
        el.remove();
      }
    });

    // 1. Move leading/trailing spaces inside strong/b/em/i tags outside the tag
    doc.querySelectorAll('strong, b, em, i').forEach(el => {
      const text = el.textContent || '';
      if (text.length > 0) {
        const hasTrailing = /\s$/.test(text);
        const hasLeading = /^\s/.test(text);
        el.textContent = text.trim();
        if (hasTrailing) {
          el.insertAdjacentText('afterend', ' ');
        }
        if (hasLeading) {
          el.insertAdjacentText('beforebegin', ' ');
        }
      }
    });

    let body = doc.body;

    // NOTE: Real HTML tables (TUF's SQL schema tables) and hand-typed ASCII example tables inside <pre> both need their exact whitespace preserved.
    // NOTE: The prose regex pipeline below collapses runs of spaces to one, which would destroy a <pre> block's column alignment and a table's cell boundaries alike.
    // NOTE: Both are swapped here for a placeholder token the pipeline cannot touch, then restored verbatim as the final step, after every other transformation has run.
    const protectedBlocks = [];
    const protect = (markdownText) => {
      const token = `ZZTUFHUBBLOCKZZ${protectedBlocks.length}ZZ`;
      protectedBlocks.push(markdownText);
      const marker = doc.createElement('p');
      marker.textContent = token;
      return marker;
    };

    body.querySelectorAll('table').forEach(table => {
      const rows = Array.from(table.querySelectorAll('tr')).map(tr =>
        Array.from(tr.querySelectorAll('th, td')).map(cell => (cell.textContent || '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'))
      );
      if (rows.length === 0) return;
      const colCount = Math.max(...rows.map(r => r.length));
      const toLine = (row) => `| ${Array.from({ length: colCount }, (_, i) => row[i] || '').join(' | ')} |`;
      const lines = [toLine(rows[0]), toLine(Array(colCount).fill('---')), ...rows.slice(1).map(toLine)];
      (table.closest('figure') || table).replaceWith(protect(lines.join('\n')));
    });

    body.querySelectorAll('pre').forEach(pre => {
      pre.replaceWith(protect('```\n' + pre.textContent.replace(/\n+$/, '') + '\n```'));
    });

    // NOTE: Converts Examples and Constraints sections into formatted Markdown blocks.
    // Matches both legacy .tuf-vstack and semantic <section> containers.
    body.querySelectorAll('.tuf-vstack, section').forEach(vstack => {
      // NOTE: TUF's own section heading level has drifted before (BUG-003) and has drifted again since: today's live pages use <h2 class="sectionTitle">, matched here alongside the older tags this selector already handled.
      const headerElem = vstack.querySelector('.tuf-text-14, h2, h3, h4, .tuf-header');
      const rawHeader = headerElem ? (headerElem.innerText || headerElem.textContent).trim() : '';
      const headerText = rawHeader.replace(/<[^>]*>/g, '');

      if (/Example\s*\d+/i.test(headerText)) {
        // Was .tuf-example: now just the section's own non-heading child.
        const exBox = vstack.querySelector('.tuf-example') ||
          Array.from(vstack.children).find(c => c !== headerElem);
        if (exBox) {
          // TUF's own source repeats the heading as a paragraph inside the section body (e.g. "Example 1:" again right under the "Example 1:" heading, past an empty decorative divider), so drop it to avoid printing it twice.
          const normalize = (s) => s.trim().replace(/:$/, '').toLowerCase();
          const firstP = exBox.querySelector('p');
          if (firstP && normalize(firstP.textContent) === normalize(headerText)) {
            firstP.remove();
          }

          const exHtml = exBox.innerHTML
            .replace(/<strong>Input\s*:?<\/strong>\s*:?/gi, '\n\n**Input:** ')
            .replace(/<strong>Output\s*:?<\/strong>\s*:?/gi, '\n\n**Output:** ')
            .replace(/<strong>Explanation\s*:?<\/strong>\s*:?/gi, '\n\n**Explanation:** ');

          vstack.innerHTML = `<h3>${headerText}</h3><div>${exHtml}</div>`;
        }
      } else if (/Constraints/i.test(headerText)) {
        const constraintBox = vstack.querySelector('.tuf-dark-content-box, ul') ||
          Array.from(vstack.children).find(c => c !== headerElem);
        const cHtml = constraintBox ? constraintBox.innerHTML : vstack.innerHTML;
        vstack.innerHTML = `<h3>Constraints</h3><div>${cHtml}</div>`;
      }
    });

    let markdown = body.innerHTML;

    // NOTE: Regular expressions use the 's' flag so wildcard captures span multiline tag bodies.
    // Paragraph tags are replaced independently rather than in pairs to handle malformed unclosed <p> tags.
    markdown = markdown
      .replace(/<h3>(.*?)<\/h3>/gis, '\n\n### $1\n\n')
      .replace(/<sup>(.*?)<\/sup>/gis, '^$1')
      .replace(/<sub>(.*?)<\/sub>/gis, '_$1')
      .replace(/<strong>(.*?)<\/strong>/gis, ' **$1** ')
      .replace(/<b>(.*?)<\/b>/gis, ' **$1** ')
      .replace(/<em>(.*?)<\/em>/gis, ' *$1* ')
      .replace(/<i>(.*?)<\/i>/gis, ' *$1* ')
      .replace(/<code>(.*?)<\/code>/gis, ' `$1` ')
      .replace(/<li[^>]*>(.*?)<\/li>/gis, '- $1\n')
      .replace(/<\/?ul[^>]*>/gi, '\n')
      .replace(/<\/?ol[^>]*>/gi, '\n')
      .replace(/<p[^>]*>/gi, '\n\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<div[^>]*>/gi, '')
      .replace(/<\/div>/gi, '\n')
      .replace(/<span[^>]*>/gi, '')
      .replace(/<\/span>/gi, '')
      .replace(/<pre[^>]*>/gi, '\n')
      .replace(/<\/pre>/gi, '\n')
      .replace(/<header[^>]*>/gi, '')
      .replace(/<\/header>/gi, '\n')
      .replace(/<section[^>]*>/gi, '')
      .replace(/<\/section>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"');

    // Ensure double newlines before Input/Output/Explanation so Markdown renders bold
    markdown = markdown
      .replace(/(\n|^)\s*\*\*(Input|Output|Explanation):\*\*/gi, '\n\n**$2:**')
      .replace(/[ \t]+/g, ' ')
      .replace(/ \n/g, '\n')
      .replace(/\n /g, '\n')
      .replace(/\*\*\s+:\s*\*\*/g, ':**')
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

    // Restored last, once nothing further will touch their internal whitespace.
    protectedBlocks.forEach((block, i) => {
      markdown = markdown.replace(`ZZTUFHUBBLOCKZZ${i}ZZ`, () => block);
    });

    return markdown.length > 20 ? markdown : 'Problem description available on TakeUForward (TUF+).';
  } catch (e) {
    return html.replace(/<[^>]+>/g, '').trim();
  }
}
