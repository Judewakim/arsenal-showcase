// Minimal test helpers. No framework on purpose: this repo has no build step and
// no test runner, and the things worth testing here are pure functions over
// plain data. `node test/run.mjs` is the whole harness.

let currentSuite = '';
const results = [];

export function suite(name) {
  currentSuite = name;
  console.log('\n\x1b[1m' + name + '\x1b[0m');
}

export function check(name, passed, detail = '') {
  results.push({ suite: currentSuite, name, passed });
  const mark = passed ? '\x1b[32m  ok  \x1b[0m' : '\x1b[31m FAIL \x1b[0m';
  console.log(mark + name + (passed || !detail ? '' : '\n        ' + detail));
}

export const eq = (name, actual, expected) =>
  check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

export const deepEq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

export function report() {
  const failed = results.filter(r => !r.passed);
  const line = '\n' + '─'.repeat(52);
  console.log(line);
  if (!failed.length) {
    console.log(`\x1b[32m${results.length} passed\x1b[0m`);
    return 0;
  }
  console.log(`\x1b[31m${failed.length} failed\x1b[0m, ${results.length - failed.length} passed\n`);
  for (const f of failed) console.log(`  ${f.suite} → ${f.name}`);
  return 1;
}
