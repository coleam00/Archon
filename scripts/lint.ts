import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import archonScriptsTsconfig from '../.archon/scripts/tsconfig.json';
import packScriptsTsconfig from '../.archon/workflows/tsconfig.json';

const REPO_ROOT = resolve(import.meta.dir, '..');
const eslintArgs = process.argv.slice(2);

// Derived from each tsconfig project's own `include`, so lint and type-check can
// never select different files.
const archonScriptPatterns = archonScriptsTsconfig.include.map(
  pattern => `.archon/scripts/${pattern}`
);
const packScriptPatterns = packScriptsTsconfig.include.map(
  pattern => `.archon/workflows/${pattern}`
);

async function findTargets(): Promise<string[][]> {
  const packages = await readdir(resolve(REPO_ROOT, 'packages'), { withFileTypes: true });
  return [
    ...packages
      .filter(entry => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(entry => [`packages/${entry.name}/src/**/*.{ts,tsx}`]),
    ['scripts/**/*.ts'],
    archonScriptPatterns,
    packScriptPatterns,
  ];
}

async function main(): Promise<number> {
  for (const patterns of await findTargets()) {
    console.log(`Linting ${patterns.join(', ')}`);
    const child = Bun.spawn(
      [
        'node',
        'node_modules/eslint/bin/eslint.js',
        ...patterns,
        '--no-error-on-unmatched-pattern',
        '--no-warn-ignored',
        ...eslintArgs,
      ],
      {
        cwd: REPO_ROOT,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      }
    );
    const exitCode = await child.exited;
    if (exitCode !== 0) return exitCode;
  }

  return 0;
}

process.exit(await main());
