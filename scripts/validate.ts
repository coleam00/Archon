/**
 * The repository's pre-pull-request gate.
 *
 * `VALIDATE_CHECKS` is the single declaration of what that gate runs. `bun run validate` runs
 * every check; a CI job that gates one of them selects it by id with `--only`. Nothing in
 * `.github/workflows/` restates a command, so the gate a contributor runs and the gate a pull
 * request must pass cannot describe different work — `scripts/validate-ci-parity.test.ts` is the
 * mechanism that keeps that true, and it also holds the list of PR-gating commands deliberately
 * left out of here, each with its reason.
 *
 * Checks run in declaration order and the run stops at the first failure, so the list is ordered
 * roughly cheapest first: a type error surfaces in seconds rather than after the test suite. The
 * one exception is the last entry, and its comment says why it sits there.
 */
import { resolve } from 'node:path';

export interface ValidateCheck {
  /** Stable identifier. CI selects checks by it, so treat it as a contract. */
  id: string;
  /** What the check proves. Printed as the step header. */
  label: string;
  /** Argv, run from the repository root. */
  command: readonly string[];
  /** Why the check cannot run on Windows. Printed when it is skipped there. */
  skipOnWindows?: string;
}

export const VALIDATE_CHECKS: readonly ValidateCheck[] = [
  {
    id: 'cli-import-boundary',
    label: 'CLI import boundaries',
    command: ['bun', 'run', 'check:cli-import-boundary'],
  },
  {
    id: 'bundled-defaults',
    label: 'Bundled workflow and command defaults are regenerated',
    command: ['bun', 'run', 'check:bundled'],
  },
  {
    id: 'bundled-skill',
    label: 'Bundled CLI skill is regenerated',
    command: ['bun', 'run', 'check:bundled-skill'],
  },
  {
    id: 'bundled-schema',
    label: 'Bundled workflow schema is regenerated',
    command: ['bun', 'run', 'check:bundled-schema'],
  },
  {
    id: 'pi-vendor-map',
    label: 'Pi vendor map is regenerated',
    command: ['bun', 'run', 'check:pi-vendor-map'],
  },
  {
    id: 'capability-matrix',
    label: 'Provider capability matrix is regenerated',
    command: ['bun', 'run', 'check:capability-matrix'],
  },
  {
    id: 'api-types',
    label: 'Generated API types match the schemas',
    command: ['bun', 'run', 'check:api-types'],
  },
  {
    id: 'type-check',
    label: 'TypeScript across every package and script project',
    command: ['bun', 'run', 'type-check'],
  },
  {
    id: 'lint',
    label: 'ESLint, warnings included',
    command: ['bun', 'run', 'lint', '--max-warnings', '0'],
  },
  {
    id: 'format',
    label: 'Prettier formatting',
    command: ['bun', 'run', 'format:check'],
  },
  {
    id: 'installer',
    label: 'Install script, against a mocked download',
    command: ['bun', 'run', 'test:install'],
    // scripts/install.sh refuses MINGW/MSYS by design (Windows users are directed to WSL2),
    // so the installer test cannot pass in a Windows shell — in CI or on a contributor's machine.
    skipOnWindows: 'scripts/install.sh is POSIX-only and refuses to run under MINGW/MSYS',
  },
  {
    id: 'tests',
    label: 'Test suite, per-package isolation preserved',
    command: ['bun', 'run', 'test'],
  },
  // The fixture check runs LAST, after the suite, and that ordering is load-bearing on
  // Windows. Running it first put 48 workflow captures (a tree created and deleted each)
  // immediately before a suite whose own slowest tests copy trees in %TEMP% and spawn
  // `bun`/`git`: the suite stayed the same speed overall (median 0.87x of the same run on
  // dev, 2612 tests compared) but its tail blew Bun's 5s per-test budget — one timeout in
  // each of two runs, on tests that cost 350ms on dev, against zero timeouts in six dev runs.
  // Put it back in front only with Windows evidence that the tail holds.
  //
  // The docs build is not here on purpose: Astro's CLI runs under Node, and this gate must
  // run on a checkout that has only Bun. It stays a declared exclusion with its own CI job,
  // path-filtered to the docs site — see NOT_IN_VALIDATE in validate-ci-parity.test.ts.
  {
    id: 'workflow-fixtures',
    label: 'Every workflow fixture reaches its expected outcome under dry-run',
    command: ['bun', 'run', 'cli', 'workflow', 'test'],
  },
];

const REPO_ROOT = resolve(import.meta.dir, '..');

/** Ids in declaration order, so `--only` cannot reorder the run. */
export function selectChecks(only: readonly string[]): ValidateCheck[] {
  if (only.length === 0) return [...VALIDATE_CHECKS];
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

function formatDuration(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${String(Math.floor(seconds / 60))}m ${(seconds % 60).toFixed(0)}s`;
}

interface CheckResult {
  check: ValidateCheck;
  milliseconds: number;
  skipped: boolean;
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
    console.log(`$ ${check.command.join(' ')}\n`);
    const checkStartedAt = Date.now();
    const child = Bun.spawn([...check.command], {
      cwd: REPO_ROOT,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await child.exited;
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
