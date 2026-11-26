// Root README links with parentheses (BUG-019) and Unspecified difficulty detection (BUG-018).
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeRepoPath, parseMarkdownLinks, decodeRepoPath } from '../src/scripts/util.js';
import { generateRootReadmeMarkdown } from '../src/scripts/tuf/rootReadme.js';
import { detectReadmeIssues } from '../src/scripts/tuf/repair.js';

const PAREN = 'SQL/Ranking-and-Top-N-Queries/most-frequently-ordered-product(s)-for-each-customer';

test('encodeRepoPath escapes parentheses and spaces', () => {
  assert.equal(encodeRepoPath('A B/x(s)'), 'A%20B/x%28s%29');
});

test('parseMarkdownLinks reads balanced and encoded destinations whole', () => {
  const raw = parseMarkdownLinks(`[T](./${PAREN}) [SQL](./${PAREN}/solution.sql)`);
  assert.equal(raw.length, 2);
  assert.equal(decodeRepoPath(raw[0].href), PAREN);
  assert.equal(decodeRepoPath(parseMarkdownLinks(`[T](./${encodeRepoPath(PAREN)})`)[0].href), PAREN);
});

test('an unbalanced (broken) row yields no link instead of a phantom problem', () => {
  assert.deepEqual(parseMarkdownLinks('[T](./SQL/Ranking-and-Top-N-Queries/most-frequently-ordered-product(s)'), []);
});

test('generated index round-trips a parenthesis slug through the parser', () => {
  const md = generateRootReadmeMarkdown({
    solved: 1, easy: 0, medium: 1, hard: 0,
    problems: {
      'most-frequently-ordered-product(s)-for-each-customer': {
        title: 'Most Frequently Ordered Product(s) for Each Customer',
        difficulty: 'Medium',
        folderPath: PAREN,
        files: { 'solution.sql': { ext: 'sql', label: 'SQL' } },
        updatedAt: Date.UTC(2026, 10, 8)
      }
    }
  });
  const row = md.split('\n').find(l => l.includes('Most Frequently Ordered'));
  assert.ok(row.includes('%28s%29'));
  const cols = row.split('|').map(c => c.trim()).filter(Boolean);
  assert.equal(decodeRepoPath(parseMarkdownLinks(cols[1])[0].href), PAREN);
  assert.equal(decodeRepoPath(parseMarkdownLinks(cols[2])[0].href).split('/').pop(), 'solution.sql');
});

test('Unspecified detection uses classifyDifficulty, not the literal word', () => {
  const readme = d => `# [X](https://takeuforward.org/practice/sql/x)\n\n![Difficulty: ${d}](https://img.shields.io/badge/x)\n`;
  assert.ok(detectReadmeIssues(readme('Unspecified')).reasons.includes('unspecified_difficulty'));
  assert.ok(detectReadmeIssues(readme('undefined')).reasons.includes('unspecified_difficulty'));
  assert.ok(!detectReadmeIssues(readme('Basic')).reasons.includes('unspecified_difficulty'));
  assert.ok(!detectReadmeIssues(readme('Easy'), { difficulty: '⚪ Unspecified' }).reasons.includes('unspecified_difficulty'));
  assert.ok(detectReadmeIssues('# [X](https://takeuforward.org/practice/sql/x)\n', { difficulty: '' }).reasons.includes('unspecified_difficulty'));
});

test('title link with parentheses is read whole', () => {
  const url = 'https://takeuforward.org/practice/sql/most-frequently-ordered-product(s)-for-each-customer?category=c';
  assert.equal(detectReadmeIssues(`# [T](${url})\n`).url, url);
});
