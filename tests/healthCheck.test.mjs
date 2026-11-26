// Weekly read-only repo check rules, title recovery, and mixed-version link cleanup (v2.4.1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { healthCheckDue, isHealthCheckEnabled, healthIssueCount, HEALTH_CHECK_INTERVAL_MS } from '../src/scripts/tuf/healthCheck.js';
import { isSlugGuessTitle } from '../src/scripts/tuf/stats.js';
import { decodeRepoPath, parseMarkdownLinks } from '../src/scripts/util.js';
import { detectReadmeIssues } from '../src/scripts/tuf/repair.js';

test('weekly check is on unless explicitly turned off', () => {
  assert.equal(isHealthCheckEnabled(undefined), true);
  assert.equal(isHealthCheckEnabled(true), true);
  assert.equal(isHealthCheckEnabled(false), false);
});

test('a check is due when never run or a week has passed', () => {
  const now = Date.UTC(2026, 10, 26);
  assert.equal(healthCheckDue(0, now), true);
  assert.equal(healthCheckDue(now - HEALTH_CHECK_INTERVAL_MS + 60000, now), false);
  assert.equal(healthCheckDue(now - HEALTH_CHECK_INTERVAL_MS, now), true);
});

test('issue count adds duplicate groups and repair items, zero for failures', () => {
  assert.equal(healthIssueCount({ ok: true, duplicates: [{}], needsRepair: [{}, {}] }), 3);
  assert.equal(healthIssueCount({ ok: false, duplicates: [{}] }), 0);
  assert.equal(healthIssueCount(null), 0);
});

test('slug-built titles are recognized, real titles are not', () => {
  const slug = 'most-frequently-ordered-product(s)-for-each-customer';
  assert.equal(isSlugGuessTitle('Most Frequently Ordered Product(S) For Each Customer', slug), true);
  assert.equal(isSlugGuessTitle('', slug), true);
  assert.equal(isSlugGuessTitle('Most Frequently Ordered Product(s) for Each Customer', slug), false);
});

test('a double-encoded link written by v2.4.0 resolves to the real folder', () => {
  const href = './SQL/Ranking-and-Top-N-Queries/most-frequently-ordered-product%2528s%2529-for-each-customer';
  assert.equal(decodeRepoPath(parseMarkdownLinks(`[T](${href})`)[0].href), 'SQL/Ranking-and-Top-N-Queries/most-frequently-ordered-product(s)-for-each-customer');
});

test('problem README title is read for title recovery', () => {
  const readme = '# [Most Frequently Ordered Product(s) for Each Customer](https://takeuforward.org/practice/sql/x)\n';
  assert.equal(detectReadmeIssues(readme).title, 'Most Frequently Ordered Product(s) for Each Customer');
});
