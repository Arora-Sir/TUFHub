// Routing for saved-list (container) URLs and folder placement for new syncs (BUG-017, BUG-020).
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHierarchy, topicKey } from '../src/scripts/tuf/router.js';
import { placeProblem, existingTopicFolder } from '../src/scripts/tuf/repoLayout.js';
import { buildSyncJob } from '../src/scripts/tuf/syncJob.js';
import { stripUiQueryParams } from '../src/scripts/util.js';

const LIST_URL = 'https://takeuforward.org/practice/core-subject/highest-order-placing-customer?list=arorasir-sql-revision&subject=dbms-databases-and-sql-explained-deeply&sidebar=0';

test('container URL with problem_type sql routes to SQL, never Core-Subject', () => {
  const route = resolveHierarchy({ url: LIST_URL, problemType: 'sql', syllabusMainTopic: 'Aggregation and Grouping' });
  assert.equal(route.category, 'SQL');
  assert.equal(route.mainTopic, 'Aggregation-and-Grouping');
  assert.equal(route.topicAuthoritative, true);
});

test('container URL falls back to the editor language when problem_type is missing', () => {
  assert.equal(resolveHierarchy({ url: LIST_URL, language: 'mysql' }).category, 'SQL');
  assert.equal(resolveHierarchy({ url: LIST_URL, language: 'java' }).category, 'DSA');
});

test('container segment never becomes the SQL topic folder', () => {
  const route = resolveHierarchy({ url: LIST_URL, problemType: 'sql' });
  assert.notEqual(route.mainTopic, 'Core-Subject');
  assert.equal(route.topicAuthoritative, false);
});

test('normal track URLs are unchanged', () => {
  const sql = resolveHierarchy({ url: 'https://takeuforward.org/practice/sql/warmer-days?category=date-and-time-analysis', syllabusMainTopic: 'Date and Time Analysis' });
  assert.equal(sql.category, 'SQL');
  const dsa = resolveHierarchy({ url: 'https://takeuforward.org/practice/dsa/two-sum', syllabusMainTopic: 'Arrays' });
  assert.equal(dsa.category, 'DSA');
  assert.equal(dsa.mainTopic, 'Arrays');
});

test('topicKey treats case and alias variants as one topic', () => {
  assert.equal(topicKey('Ranking-And-Top-N-Queries'), topicKey('Ranking and Top N Queries'));
  assert.equal(topicKey('Date-And-Time-Analysis'), topicKey('Date-and-Time-Functions'));
  assert.notEqual(topicKey('Joins-And-Aggregation'), topicKey('Aggregation-And-Grouping'));
});

const problems = {
  'highest-order-placing-customer': { folderPath: 'SQL/Aggregation-And-Grouping/highest-order-placing-customer' },
  'email-duplicates': { folderPath: 'SQL/Aggregation-And-Grouping/email-duplicates' },
  'big-countries': { folderPath: 'SQL/Querying-And-Filtering/big-countries' },
  'stale': { folderPath: 'Core-Subject/General/stale' }
};

test('re-solve from a saved list reuses the known SQL folder', () => {
  const route = resolveHierarchy({ url: LIST_URL, problemType: 'sql' });
  const placed = placeProblem(route, problems['highest-order-placing-customer'], problems);
  assert.equal(placed.folderPath, 'SQL/Aggregation-And-Grouping/highest-order-placing-customer');
});

test('container route with no signals still reuses a real known folder', () => {
  const route = resolveHierarchy({ url: LIST_URL });
  assert.equal(route.category, 'Core-Subject');
  const placed = placeProblem(route, problems['highest-order-placing-customer'], problems);
  assert.equal(placed.category, 'SQL');
});

test('a known Core-Subject or General folder is never reused', () => {
  const route = resolveHierarchy({ url: 'https://takeuforward.org/practice/core-subject/stale', problemType: 'sql', syllabusMainTopic: 'Querying and Filtering' });
  const placed = placeProblem(route, problems.stale, problems);
  assert.equal(placed.folderPath, 'SQL/Querying-And-Filtering/stale');
});

test('new problem joins the existing topic folder spelling', () => {
  assert.equal(existingTopicFolder(problems, 'SQL', 'Querying-and-Filtering'), 'Querying-And-Filtering');
  assert.equal(existingTopicFolder(problems, 'SQL', 'Window-Functions-and-Analytics'), '');
});

test('authoritative topic in a different spelling keeps the known folder', () => {
  const route = resolveHierarchy({ url: 'https://takeuforward.org/practice/sql/email-duplicates', syllabusMainTopic: 'Aggregation and Grouping' });
  assert.equal(placeProblem(route, problems['email-duplicates'], problems).folderPath, 'SQL/Aggregation-And-Grouping/email-duplicates');
});

test('sync job for a saved-list re-solve targets the existing SQL folder with a .sql file', () => {
  const { job } = buildSyncJob({ url: LIST_URL, problemType: 'sql', language: 'mysql', code: 'SELECT 1;', title: 'Highest Order Placing Customer', difficulty: 'Easy', description: '' }, { problems }, 'test');
  assert.equal(job.folderPath, 'SQL/Aggregation-And-Grouping/highest-order-placing-customer');
  assert.equal(job.category, 'SQL');
  assert.match(job.codeFileName, /\.sql$/);
  assert.ok(!job.url.includes('list='));
  assert.ok(!job.url.includes('sidebar='));
});

test('stripUiQueryParams keeps meaningful params', () => {
  const out = stripUiQueryParams('https://takeuforward.org/practice/sql/x?category=c&tab=solution&list=l&sidebar=0');
  assert.equal(out, 'https://takeuforward.org/practice/sql/x?category=c');
});
