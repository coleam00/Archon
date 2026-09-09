import { existsSync } from 'node:fs';
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
 * Groups live in the package's own `package.json` under `testGroups`.
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

if (requested.length > 0) {
  // `bun test` treats a path that matches nothing as an empty run and exits 0, so a typo
  // or a stale path reports a pass. Refuse the run instead. Once a flag is present any
  // argument could be its value, so the whole line goes through unchecked rather than
  // this runner guessing at `bun test`'s flag grammar.
  if (!requested.some(arg => arg.startsWith('-'))) {
    const missing = requested.filter(arg => !existsSync(join(packageDir, arg)));
    if (missing.length > 0) {
      console.error(`No such test path: ${missing.join(', ')}`);
      process.exit(1);
    }
  }
  process.exit(await run(requested));
}

for (const group of groups) {
  const code = await run(group);
  if (code !== 0) process.exit(code);
}
