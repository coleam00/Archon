import { mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import archonScriptsTsconfig from '../.archon/scripts/tsconfig.json';
import packScriptsTsconfig from '../.archon/workflows/tsconfig.json';

const REPO_ROOT = resolve(import.meta.dir, '..');
const CACHE_ROOT = resolve(REPO_ROOT, 'node_modules/.cache/eslint');
const eslintArgs = process.argv.slice(2);

interface LintTarget {
  cacheName: string;
  patterns: string[];
}

// Derived from each tsconfig project's own `include`, so lint and type-check can
// never select different files.
const archonScriptPatterns = archonScriptsTsconfig.include.map(
  pattern => `.archon/scripts/${pattern}`
);
const packScriptPatterns = packScriptsTsconfig.include.map(
  pattern => `.archon/workflows/${pattern}`
);

async function findTargets(): Promise<LintTarget[]> {
  const packages = await readdir(resolve(REPO_ROOT, 'packages'), { withFileTypes: true });
  return [
    ...packages
      .filter(entry => entry.isDirectory())
      .map(entry => ({
        cacheName: entry.name,
        patterns: [`packages/${entry.name}/src/**/*.{ts,tsx}`],
      }))
      .sort((left, right) => left.cacheName.localeCompare(right.cacheName)),
    { cacheName: 'scripts', patterns: ['scripts/**/*.ts'] },
    {
      cacheName: 'archon-scripts',
      patterns: archonScriptPatterns,
    },
    {
      cacheName: 'workflow-pack-scripts',
      patterns: packScriptPatterns,
    },
  ];
}

async function main(): Promise<number> {
  await mkdir(CACHE_ROOT, { recursive: true });

  for (const target of await findTargets()) {
    console.log(`Linting ${target.patterns.join(', ')}`);
    const child = Bun.spawn(
      [
        'node',
        'node_modules/eslint/bin/eslint.js',
        ...target.patterns,
        '--cache',
        '--cache-location',
        resolve(CACHE_ROOT, target.cacheName),
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
