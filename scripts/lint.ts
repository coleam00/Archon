import { resolve } from 'node:path';
import { PERSISTENCE_PACKAGE_DIRECTORIES } from './check-workflow-persistence';

/**
 * `bun run lint`: the repository checks Biome cannot express, then Biome lint. This is the only
 * list of them. `bun run lint` runs every check over the whole repository; `check:changed`
 * asks `lintSteps` for the same list narrowed to the directories its change reaches.
 */

const REPO_ROOT = resolve(import.meta.dir, '..');

export interface LintCheck {
  id: string;
  args: readonly string[];
}

export const LINT_CHECKS = [
  { id: 'check-test-cleanup-drift', args: ['bun', 'run', 'scripts/check-test-cleanup-drift.ts'] },
  { id: 'check-mock-modules', args: ['bun', 'run', 'scripts/check-mock-modules.ts'] },
  { id: 'check-pack-portability', args: ['bun', 'run', 'scripts/check-pack-portability.ts'] },
  {
    id: 'check-workflow-persistence',
    args: ['bun', 'run', 'scripts/check-workflow-persistence.ts'],
  },
  { id: 'check-sdk-type-drift', args: ['bun', 'run', 'scripts/check-sdk-type-drift.ts'] },
  { id: 'check-web-api-types', args: ['bun', 'run', 'scripts/check-web-api-types.ts'] },
  { id: 'check-console-tokens', args: ['bun', 'run', 'scripts/check-console-tokens.ts'] },
  { id: 'biome', args: ['bun', 'x', 'biome', 'lint', '--error-on-warnings', '.'] },
] as const satisfies readonly LintCheck[];

export interface LintStep extends LintCheck {
  run: 'whole' | 'scoped' | 'skipped';
  /** The directories a scoped step reads, or why a step is skipped; empty for a whole run. */
  note: string;
}

/** Repository-relative directories, such as `packages/chat-slack` or `scripts`. */
export interface LintScope {
  directories: readonly string[];
}

/**
 * Every lint check, run whole without a scope. With one, check-mock-modules reads only the
 * mocking files under the scope's directories, and check-workflow-persistence runs only when
 * a package that holds its consumers or the persistence they must not reach is in scope. Every
 * other check costs little and stays whole.
 */
export function lintSteps(scope?: LintScope): LintStep[] {
  return LINT_CHECKS.map((check): LintStep => {
    const whole: LintStep = { ...check, run: 'whole', note: '' };
    if (scope === undefined) return whole;
    const { directories } = scope;
    if (check.id === 'check-mock-modules') {
      if (directories.length === 0) {
        return { ...whole, run: 'skipped', note: 'no package or root scripts in scope' };
      }
      return {
        ...check,
        args: [...check.args, ...directories.flatMap(directory => ['--scope', directory])],
        run: 'scoped',
        note: directories.join(', '),
      };
    }
    if (check.id === 'check-workflow-persistence') {
      const reached = directories.some(directory =>
        PERSISTENCE_PACKAGE_DIRECTORIES.includes(directory)
      );
      if (!reached) {
        return {
          ...whole,
          run: 'skipped',
          note: `none of ${PERSISTENCE_PACKAGE_DIRECTORIES.join(', ')} in scope`,
        };
      }
    }
    return whole;
  });
}

if (import.meta.main) {
  // One after another, stopping at the first failure, as the `&&` chain this replaced did.
  for (const step of lintSteps()) {
    const code = await Bun.spawn([...step.args], {
      cwd: REPO_ROOT,
      stdio: ['inherit', 'inherit', 'inherit'],
    }).exited;
    if (code !== 0) {
      process.exitCode = code;
      break;
    }
  }
}
