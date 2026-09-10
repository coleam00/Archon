import { join } from 'node:path';

/**
 * Runs one package's tests, from that package's directory.
 *
 * A package splits its suite into groups that each get a fresh `bun test` process,
 * because mocks leak between files inside a single process. Expressing those groups
 * as `bun test ... && bun test ...` directly in the `test` script has a trap: `bun run`
 * appends its arguments to whatever the script expands to, so `bun run test <path>`
 * runs the whole chain and then tacks the path onto the last group. Going through this
 * runner makes the argument mean what it says.
 *
 * Groups live in the package's own `package.json` under `testGroups`, which is also
 * where `scripts/test-inventory.test.ts` reads them to prove every test file is run.
 */

interface PackageManifest {
  name?: string;
  testGroups?: string[][];
}

const packageDir = process.cwd();
const manifestPath = join(packageDir, 'package.json');
const manifest = (await Bun.file(manifestPath).json()) as PackageManifest;
const groups = manifest.testGroups;

if (!Array.isArray(groups) || groups.length === 0) {
  console.error(`${manifestPath} has no "testGroups" array`);
  process.exit(1);
}

const run = async (args: string[]): Promise<number> => {
  const child = Bun.spawn(['bun', 'test', ...args], {
    cwd: packageDir,
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  return await child.exited;
};

const requested = Bun.argv.slice(2);

// Requested arguments go through verbatim. Do not add a path-existence check here:
// `bun test` already exits 1 when a selector matches no test file, and its selectors are
// substring filters rather than paths, so `bun run test logger` is a valid run that any
// such check would refuse. The exit-0-on-a-bad-path this runner was written to fix came
// from `bun run` appending the argument to a chain whose other selectors still matched.
if (requested.length > 0) process.exit(await run(requested));

for (const group of groups) {
  const code = await run(group);
  if (code !== 0) process.exit(code);
}
