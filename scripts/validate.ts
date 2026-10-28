import { formatDuration } from '@archon/paths/duration';
import { resolve } from 'node:path';

type Command = readonly [string, ...string[]];
export type CheckCommands = readonly [Command, ...Command[]];

export interface ValidateCheck {
  id: string;
  label: string;
  commands: CheckCommands;
  explicitOnly?: boolean;
  skipOnWindows?: string;
}

// CI selects from this registry; local defaults omit the expensive fixture checks.
export const VALIDATE_CHECKS: readonly ValidateCheck[] = [
  {
    id: 'cli-import-boundary',
    label: 'CLI import boundaries',
    commands: [['bun', 'run', 'check:cli-import-boundary']],
  },
  {
    id: 'package-edges',
    label:
      'Declared @archon dependencies match the package layering, and the engine and pack stay apart',
    commands: [['bun', 'run', 'check:package-edges']],
  },
  {
    id: 'generated-files',
    label: 'Generated files match their sources',
    commands: [
      ['bun', 'run', 'check:pi-vendor-map'],
      ['bun', 'run', 'check:capability-matrix'],
      ['bun', 'run', 'check:provider-contract-schema'],
      ['bun', 'run', 'check:chat-contract-schema'],
      ['bun', 'run', 'check:api-types'],
    ],
  },
  {
    id: 'merge-sweep-contract',
    label: 'Merge sweep schema agrees with its recorder contract',
    commands: [['bun', 'run', 'test', '.archon/scripts/__tests__/merge-sweep-contract.test.ts']],
  },
  {
    id: 'type-check',
    label: 'TypeScript across every package and script project',
    commands: [['bun', 'run', 'type-check']],
  },
  {
    id: 'lint',
    label: 'Biome lint and repository checks',
    commands: [['bun', 'run', 'lint']],
  },
  {
    id: 'mock-modules',
    label: 'Every mock.module() factory provides every export of its module, or is in the baseline',
    commands: [['bun', 'run', 'check:mock-modules']],
  },
  {
    id: 'ratchet',
    label:
      'Touched functions and files are no more complex or longer than on the base, and the mock.module() baseline does not grow',
    commands: [['bun', 'run', 'check:ratchet']],
  },
  {
    id: 'format',
    label: 'Biome formatting',
    commands: [['bun', 'run', 'format:check']],
  },
  {
    id: 'installer',
    label: 'Install script, against a mocked download',
    commands: [['bun', 'run', 'test:install']],
    skipOnWindows: 'scripts/install.sh is POSIX-only and refuses to run under MINGW/MSYS',
  },
  {
    id: 'package-tests',
    label:
      'Workspace package tests except @archon/cli and @archon/core, per-package isolation preserved',
    commands: [['bun', 'run', 'test', '--plan', 'packages']],
  },
  {
    id: 'cli-tests',
    label: '@archon/cli package tests',
    commands: [['bun', 'run', 'test', '--plan', 'cli']],
  },
  {
    id: 'core-tests',
    label: '@archon/core package tests',
    commands: [['bun', 'run', 'test', '--plan', 'core']],
  },
  {
    id: 'script-tests',
    label: 'Repository script tests',
    commands: [['bun', 'run', 'test', '--plan', 'scripts']],
  },
  {
    id: 'pack-tests',
    label: 'Pack script tests under .archon/scripts/',
    commands: [['bun', 'run', 'test', '--plan', 'pack']],
    explicitOnly: true,
  },
  {
    id: 'workflow-fixtures',
    label: 'Workflow fixtures reach their expected dry-run outcomes',
    commands: [['bun', 'run', 'cli', 'workflow', 'test']],
    explicitOnly: true,
  },
];

const REPO_ROOT = resolve(import.meta.dir, '..');

/** Ids in declaration order, so `--only` cannot reorder the run. */
export function selectChecks(only: readonly string[]): ValidateCheck[] {
  if (only.length === 0) return VALIDATE_CHECKS.filter(check => !check.explicitOnly);
  const requested = new Set(only);
  const unknown = only.filter(id => !VALIDATE_CHECKS.some(check => check.id === id));
  if (unknown.length > 0) {
    throw new Error(
      [
        `Unknown check id: ${unknown.join(', ')}`,
        `Known ids: ${VALIDATE_CHECKS.map(check => check.id).join(', ')}`,
      ].join('\n')
    );
  }
  return VALIDATE_CHECKS.filter(check => requested.has(check.id));
}

/**
 * `--only <id>[,<id>]` selects checks and may repeat. Any other argument is rejected rather
 * than ignored, because a CI job passing one would otherwise report green on a run that
 * checked something other than what the job's author asked for.
 */
export function parseOnly(argv: readonly string[]): string[] {
  const only: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const inlineValue = argument.startsWith('--only=') ? argument.slice('--only='.length) : null;
    const value = inlineValue ?? (argument === '--only' ? argv[++index] : undefined);
    if (value === undefined || value.length === 0) {
      const problem = argument === '--only' ? '--only needs a check id' : 'unsupported argument';
      throw new Error(`${problem}: ${argument}\nUsage: bun run validate [--only <id>[,<id>...]]`);
    }
    only.push(...value.split(',').filter(id => id.length > 0));
  }
  return only;
}

interface CheckResult {
  check: ValidateCheck;
  milliseconds: number;
  skipped: boolean;
}

export async function runCheckCommands(commands: CheckCommands, cwd: string): Promise<number> {
  for (const command of commands) {
    console.log(`$ ${command.join(' ')}\n`);
    const child = Bun.spawn([...command], {
      cwd,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const code = await child.exited;
    if (code !== 0) {
      console.error(`Command failed (${String(code)}): ${command.join(' ')}`);
      return code;
    }
  }
  return 0;
}

async function main(): Promise<number> {
  const checks = selectChecks(parseOnly(Bun.argv.slice(2)));
  const onWindows = process.platform === 'win32';
  const results: CheckResult[] = [];
  const startedAt = Date.now();

  for (const check of checks) {
    if (onWindows && check.skipOnWindows !== undefined) {
      console.log(`\n=== SKIP ${check.id} — ${check.skipOnWindows} ===\n`);
      results.push({ check, milliseconds: 0, skipped: true });
      continue;
    }

    console.log(`\n=== ${check.id} — ${check.label} ===`);
    const checkStartedAt = Date.now();
    const exitCode = await runCheckCommands(check.commands, REPO_ROOT);
    const milliseconds = Date.now() - checkStartedAt;

    if (exitCode !== 0) {
      console.error(
        [
          '',
          `validate failed: ${check.id} exited ${String(exitCode)} after ${formatDuration(milliseconds)}.`,
          `Re-run just this check with: bun run validate --only ${check.id}`,
        ].join('\n')
      );
      return exitCode;
    }
    results.push({ check, milliseconds, skipped: false });
  }

  const total = Date.now() - startedAt;
  console.log(`\n=== validate passed in ${formatDuration(total)} ===`);
  for (const result of results) {
    const detail = result.skipped ? 'skipped' : formatDuration(result.milliseconds);
    console.log(`  ${result.check.id.padEnd(22)} ${detail}`);
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
