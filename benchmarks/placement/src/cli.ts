import { checkPin, writePin } from './product';
import { runAll } from './scenarios';

function run(): number {
  const pin = checkPin();
  const results = runAll();
  console.log(`Product pinned at ${pin.commit}\n`);
  for (const scenario of results) {
    console.log(`${scenario.pass ? 'PASS' : 'FAIL'}  ${scenario.id}  ${scenario.variant}`);
    for (const each of scenario.checks) {
      console.log(`      ${each.pass ? 'ok  ' : 'FAIL'}  ${each.name}: ${each.detail}`);
    }
  }
  const failed = results.filter((scenario) => !scenario.pass).length;
  console.log(`\n${results.length - failed} of ${results.length} scenarios pass`);
  return failed === 0 ? 0 : 1;
}

const [command = 'run', ...args] = process.argv.slice(2);
if (command === 'pin') {
  if (!args[0]) throw new Error('usage: pnpm bench pin <commit>');
  console.log(`Pinned ${writePin(args[0]).commit}`);
} else if (command === 'run') {
  process.exitCode = run();
} else {
  throw new Error(`unknown command ${command}; use run or pin <commit>`);
}
