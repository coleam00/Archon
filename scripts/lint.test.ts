import { describe, expect, test } from 'bun:test';
import { LINT_CHECKS, lintSteps } from './lint';

const byId = (directories: string[]) =>
  Object.fromEntries(lintSteps({ directories }).map(step => [step.id, step]));

describe('lintSteps', () => {
  test('without a scope, every check runs whole in the order `bun run lint` ran them', () => {
    const steps = lintSteps();
    expect(steps.map(step => step.run)).toEqual(LINT_CHECKS.map(() => 'whole'));
    expect(steps.map(step => step.args.join(' '))).toEqual([
      'bun run scripts/check-test-cleanup-drift.ts',
      'bun run scripts/check-mock-modules.ts',
      'bun run scripts/check-pack-portability.ts',
      'bun run scripts/check-workflow-persistence.ts',
      'bun run scripts/check-sdk-type-drift.ts',
      'bun run scripts/check-web-api-types.ts',
      'bun run scripts/check-console-tokens.ts',
      'bun x biome lint --error-on-warnings .',
    ]);
  });

  test('a leaf package scopes mock-modules to it and skips workflow persistence', () => {
    const steps = byId(['packages/chat-slack', 'scripts']);
    expect(steps['check-mock-modules'].run).toBe('scoped');
    expect(steps['check-mock-modules'].args.slice(-4)).toEqual([
      '--scope',
      'packages/chat-slack',
      '--scope',
      'scripts',
    ]);
    expect(steps['check-workflow-persistence'].run).toBe('skipped');
    expect(steps['check-sdk-type-drift'].run).toBe('whole');
    expect(steps.biome.run).toBe('whole');
  });

  test('a scope that holds a persistence consumer runs workflow persistence', () => {
    expect(byId(['packages/cli'])['check-workflow-persistence'].run).toBe('whole');
  });

  test('an empty scope skips mock-modules rather than reading the whole repository', () => {
    expect(byId([])['check-mock-modules'].run).toBe('skipped');
  });
});
