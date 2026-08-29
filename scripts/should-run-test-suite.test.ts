import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldRunTestSuite } from './should-run-test-suite';

const EMPTY_GIT_SHA = '0000000000000000000000000000000000000000';

describe('test-suite change decision', () => {
  test.each(['push', 'pull_request'])('%s skips Markdown-only changes', () => {
    expect(shouldRunTestSuite(['README.md', 'packages/core/notes.md'])).toBe(false);
  });

  test.each(['push', 'pull_request'])('%s skips docs-source-only changes', () => {
    expect(
      shouldRunTestSuite([
        'packages/docs-web/src/content/docs/guide.mdx',
        'packages/docs-web/public/logo.svg',
      ])
    ).toBe(false);
  });

  test.each(['push', 'pull_request'])('%s runs when the docs manifest changes', () => {
    expect(shouldRunTestSuite(['packages/docs-web/package.json'])).toBe(true);
  });

  test('runs for a non-documentation change after thousands of documentation files', () => {
    const changedFiles = [
      ...Array.from({ length: 3_001 }, (_, index) => `docs/${index}.md`),
      'packages/docs-web/package.json',
    ];

    expect(shouldRunTestSuite(changedFiles)).toBe(true);
  });

  test.each([
    ['.archon/commands/defaults/archon-assist.md', 'a legacy command prompt'],
    ['.archon/workflows/sdlc/implement/commands/implement.md', 'a packaged command prompt'],
    ['.claude/skills/archon-cli/SKILL.md', 'the bundled CLI skill'],
    ['packages/docs-web/src/content/docs/reference/provider-capabilities.md', 'a generated doc'],
  ])('runs for %s, which is %s rather than prose', file => {
    expect(shouldRunTestSuite([file])).toBe(true);
  });

  test('still skips genuine prose, inside the docs site and out', () => {
    expect(
      shouldRunTestSuite([
        'README.md',
        'AGENTS.md',
        'packages/docs-web/src/content/docs/guides/authoring-workflows.md',
      ])
    ).toBe(false);
  });

  /**
   * The exclusion list above is written by hand, so it can only stay true if something checks it
   * against what the build actually reads. `bundled-skill.ts` compiles each of these files into
   * the CLI with a text import, which makes its import list the owning source for that family.
   */
  test('every Markdown file compiled into the CLI skill runs the suite', () => {
    const bundledSkill = readFileSync(
      resolve(import.meta.dir, '../packages/cli/src/bundled-skill.ts'),
      'utf8'
    );
    const imported = [...bundledSkill.matchAll(/'[^']*\/(\.claude\/skills\/[^']+\.md)'/g)].map(
      match => match[1]
    );

    expect(imported.length).toBeGreaterThan(0);
    for (const file of imported) expect(shouldRunTestSuite([file])).toBe(true);
  });

  test('runs for a push that creates a branch', () => {
    const script = resolve(import.meta.dir, 'should-run-test-suite.ts');
    const result = Bun.spawnSync(['bun', script, 'push', EMPTY_GIT_SHA, 'unavailable-head'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe('true');
  });

  /**
   * A force-push leaves `github.event.before` unreachable. The decision must still be a decision:
   * an empty stdout here is read as "skip" by every downstream gate.
   */
  test('an unreadable diff resolves to running the suite, with the cause on stderr', () => {
    const script = resolve(import.meta.dir, 'should-run-test-suite.ts');
    const unreachable = '1'.repeat(40);
    const result = Bun.spawnSync(['bun', script, 'push', unreachable, 'HEAD'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe('true');
    expect(result.stderr.toString()).toContain(`Could not compare ${unreachable}..HEAD`);
  });

  test('a bad argument stays fatal, so the step cannot publish an empty decision', () => {
    const script = resolve(import.meta.dir, 'should-run-test-suite.ts');
    const result = Bun.spawnSync(['bun', script, 'not-a-github-event', 'base', 'head'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString().trim()).toBe('');
    expect(result.stderr.toString()).toContain('Unsupported GitHub event: not-a-github-event');
  });

  test('the workflow delegates both automatic routes to the complete-diff decision', () => {
    // A Windows checkout writes the workflow with CRLF endings, and every assertion below
    // anchors on LF. Normalize at the read site: what is asserted is YAML structure, not
    // the line terminator the working tree happens to carry.
    const workflow = readFileSync(
      resolve(import.meta.dir, '../.github/workflows/test.yml'),
      'utf8'
    ).replaceAll('\r\n', '\n');
    const changesJob = workflow.slice(workflow.indexOf('  changes:'), workflow.indexOf('  test:'));

    expect(workflow).toContain('  push:\n');
    expect(workflow).toContain('  pull_request:\n');
    expect(workflow).not.toContain('\n    paths:');
    expect(changesJob).toContain('EVENT_NAME: ${{ github.event_name }}');
    expect(changesJob).toContain(
      'BASE_SHA: ${{ github.event.before || github.event.pull_request.base.sha }}'
    );
    expect(changesJob).toContain(
      'HEAD_SHA: ${{ github.event.after || github.event.pull_request.head.sha }}'
    );
    expect(changesJob).toContain('fetch-depth: 0');
    expect(changesJob).toContain('uses: oven-sh/setup-bun@v2');

    // Pin the invocation itself, not just its parts. The script reads three positional
    // arguments, so a reordering that sends a SHA into `eventName` has to fail here — and the
    // assignment must stay separate from the `echo`, which is what makes a crash fail the step.
    expect(changesJob).toContain(
      'run_tests=$(bun scripts/should-run-test-suite.ts "$EVENT_NAME" "$BASE_SHA" "$HEAD_SHA")\n'
    );
    expect(changesJob).toContain('echo "run-tests=$run_tests" >> "$GITHUB_OUTPUT"');
  });

  test('the workflow fixture gate feeds the required test-suite result', () => {
    const workflow = readFileSync(
      resolve(import.meta.dir, '../.github/workflows/test.yml'),
      'utf8'
    ).replaceAll('\r\n', '\n');
    const workflowFixtures = workflow.slice(
      workflow.indexOf('  workflow-fixtures:'),
      workflow.indexOf('  test:')
    );
    const testSuite = workflow.slice(workflow.indexOf('  test-suite:'));

    expect(workflowFixtures).toContain('needs: changes');
    expect(workflowFixtures).toContain("if: needs.changes.outputs.run-tests == 'true'");
    expect(workflowFixtures).toContain('runs-on: ubuntu-latest');
    expect(workflowFixtures).toContain('run: bun install --frozen-lockfile');
    expect(workflowFixtures).toContain('run: bun run cli workflow test --json');
    expect(testSuite).toContain('workflow-fixtures');
    expect(testSuite).toContain('WORKFLOW_FIXTURES: ${{ needs.workflow-fixtures.result }}');
    expect(testSuite).toContain('"$WORKFLOW_FIXTURES"');
  });
});
