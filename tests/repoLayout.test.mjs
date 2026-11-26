// Duplicate merge plans, topic split detection, and folder relocation (BUG-017, BUG-020).
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMergePlan, mergeOrder, findTopicSplits, relocationPlan } from '../src/scripts/tuf/repoLayout.js';

const folder = (folderPath, details, lastModified) => ({
  folderPath,
  files: details.map(d => `${folderPath}/${d.name}`).concat(`${folderPath}/README.md`),
  fileDetails: details,
  lastModified
});

test('real track folder is kept over a newer Core-Subject copy', () => {
  const sql = folder('SQL/Aggregation-And-Grouping/hopc', [{ name: 'solution.sql', sha: 'A' }], 1);
  const core = folder('Core-Subject/General/hopc', [{ name: 'CTE.sql', sha: 'B' }, { name: 'Solution-1.sql', sha: 'A' }], 2);
  assert.equal(mergeOrder([core, sql])[0].folderPath, sql.folderPath);
  const plan = computeMergePlan([core, sql]);
  assert.equal(plan.canonicalFolder, sql.folderPath);
  // Identical content (sha A) is not copied again, the unique CTE is.
  assert.deepEqual(plan.moves.map(m => m.targetPath), ['SQL/Aggregation-And-Grouping/hopc/CTE.sql']);
  assert.deepEqual(plan.deletedFolderPaths, ['Core-Subject/General/hopc']);
  assert.ok(plan.deletes.includes('Core-Subject/General/hopc/README.md'));
});

test('same-name file with different content is kept as Solution-N, never dropped', () => {
  const sql = folder('SQL/Querying-And-Filtering/etl', [{ name: 'solution.sql', sha: 'OLD' }], 1);
  const core = folder('Core-Subject/General/etl', [{ name: 'solution.sql', sha: 'NEW' }], 2);
  const plan = computeMergePlan([core, sql]);
  assert.deepEqual(plan.moves, [{ fromPath: 'Core-Subject/General/etl/solution.sql', targetPath: 'SQL/Querying-And-Filtering/etl/Solution-2.sql', sha: 'NEW' }]);
});

test('between two real folders the newest is kept', () => {
  const a = folder('DSA/Arrays/x', [{ name: 'solution.cpp', sha: '1' }], 5);
  const b = folder('DSA/Hashing/x', [{ name: 'solution.cpp', sha: '2' }], 9);
  assert.equal(computeMergePlan([a, b]).canonicalFolder, 'DSA/Hashing/x');
});

test('case-only topic splits move to the majority spelling', () => {
  const paths = [
    'SQL/Ranking-And-Top-N-Queries/a', 'SQL/Ranking-And-Top-N-Queries/b',
    'SQL/Ranking-and-Top-N-Queries/c', 'SQL/Ranking-and-Top-N-Queries/d', 'SQL/Ranking-and-Top-N-Queries/e',
    'SQL/Window-Functions-Pre/w', 'SQL/Window-Functions-and-Analytics/v',
    'Core-Subject/General/z'
  ];
  assert.deepEqual(findTopicSplits(paths), [
    { folderPath: 'SQL/Ranking-And-Top-N-Queries/a', relocateTo: 'SQL/Ranking-and-Top-N-Queries/a' },
    { folderPath: 'SQL/Ranking-And-Top-N-Queries/b', relocateTo: 'SQL/Ranking-and-Top-N-Queries/b' }
  ]);
});

test('split detection skips duplicate-group folders and occupied destinations', () => {
  const paths = ['SQL/T-And-X/a', 'SQL/T-And-X/b', 'SQL/T-and-X/a', 'SQL/T-and-X/c', 'SQL/T-and-X/d'];
  assert.deepEqual(findTopicSplits(paths, new Set(['SQL/T-And-X/b'])), []);
});

test('relocation moves every file including README and deletes the old paths', () => {
  const plan = relocationPlan('SQL/Old/a', [{ name: 'solution.sql', sha: 's1' }], 'r1', 'SQL/New/a');
  assert.deepEqual(plan.moves.map(m => m.targetPath), ['SQL/New/a/solution.sql', 'SQL/New/a/README.md']);
  assert.deepEqual(plan.deletes, ['SQL/Old/a/solution.sql', 'SQL/Old/a/README.md']);
});
