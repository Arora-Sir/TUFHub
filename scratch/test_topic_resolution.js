import { resolveHierarchy } from '../src/scripts/tuf/router.js';

const testData1 = {
  title: 'Letter Combinations of a Phone Number',
  url: 'https://takeuforward.org/plus/dsa/letter-combinations-of-a-phone-number/letter-combinations-of-a-phone-number',
  language: 'java',
  difficulty: 'Hard'
};

const testData2 = {
  title: 'Letter Combinations of a Phone Number',
  url: 'https://takeuforward.org/plus/dsa/letter-combinations-of-a-phone-number',
  language: 'java',
  difficulty: 'Hard'
};

console.log('Test 1 Result:', resolveHierarchy(testData1));
console.log('Test 2 Result:', resolveHierarchy(testData2));
