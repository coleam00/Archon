/**
 * What the SDLC pack still states about the forge contract by hand: its close reasons, and
 * which operations each preflight asks the host for. The pack's forge calls themselves are
 * typed by `archon:script`.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeReasonSchema, mutationOperationSchema } from '../packages/forge/src/lifecycle';
import { type ForgeRequest, forgeRequestSchema } from '../packages/forge/src/operations';
import { REQUIRED_FORGE_OPERATIONS } from '../.archon/workflows/sdlc/.shared/forge-check';
import { MERGE_QUEUE_FORGE_OPERATIONS } from '../.archon/workflows/sdlc/.shared/merge';
import { TEST_VALUE_FORGE_OPERATIONS } from '../.archon/workflows/sdlc/.shared/test-value';
import { CLOSE_REASONS } from '../.archon/workflows/sdlc/.shared/issue';

test('every reason the pack closes an issue with is a forge close reason', () => {
  for (const reason of CLOSE_REASONS) expect(closeReasonSchema.parse(reason)).toBe(reason);
});

/**
 * Reads only an agent calls, from a prompt. No workflow preflights them: nothing a run
 * writes depends on one, the host refuses the call by name (`unsupported_op`) on a
 * plugin without it, and the prompt has the agent report that refusal. A preflight
 * would instead refuse a whole delivery, on a plugin that can make every write, for a
 * log read only a red check needs. A script that calls one owes it a preflight, so
 * each must stay out of every pack script.
 */
const AGENT_READ_OPERATIONS: readonly ForgeRequest['op'][] = ['workitem.search', 'checks.logs'];

// Delivery, the merge queue and the test-value metric each preflight their own
// operations; merge-queue.test.ts proves the merge queue's list against the operations
// it calls.
test('preflight capabilities cover the forge operations the pack calls', () => {
  const root = join(import.meta.dir, '../.archon/workflows/sdlc');
  const sources = [...new Bun.Glob('**/*.{ts,md}').scanSync({ cwd: root, dot: true })]
    .filter(file => file !== '.shared/forge-check.ts' && file !== '.shared/merge.ts')
    .map(file => ({ file, text: readFileSync(join(root, file), 'utf8') }));
  const named = (op: string, kind: '.ts' | '.md'): string[] =>
    sources
      .filter(
        ({ file, text }) =>
          file.endsWith(kind) &&
          [`'${op}'`, `"${op}"`, `\`${op}\``, `forge ${op} `].some(token => text.includes(token))
      )
      .map(({ file }) => file);
  for (const op of AGENT_READ_OPERATIONS) {
    expect(mutationOperationSchema.safeParse(op).success).toBe(false);
    expect(named(op, '.md')).not.toEqual([]);
    expect(named(op, '.ts')).toEqual([]);
  }
  const used: ForgeRequest['op'][] = forgeRequestSchema.options
    .map(schema => schema.shape.op.value)
    .filter(op => named(op, '.ts').length + named(op, '.md').length > 0)
    .filter(op => !AGENT_READ_OPERATIONS.includes(op))
    // `resolve` runs no preflight: a workflow calls it first, only when its repo inputs
    // are empty, so the host's refusal already comes before any spend.
    .filter(op => op !== 'resolve');
  expect(used).toContain('checks.state');
  // Typed as operation names, so a capability token such as `pr.view:any-state` cannot
  // enter a preflight list. The build queue's any-state lookup runs no preflight: the
  // host refuses it on a plugin without the capability, naming it.
  const preflighted = new Set<ForgeRequest['op']>([
    ...REQUIRED_FORGE_OPERATIONS,
    ...MERGE_QUEUE_FORGE_OPERATIONS,
    ...TEST_VALUE_FORGE_OPERATIONS,
  ]);
  // The merge queue's own calls sit in `.shared/merge.ts` beside its list, which this
  // scan skips; merge-queue.test.ts holds that list to the operations it calls.
  expect(used.filter(op => !preflighted.has(op))).toEqual([]);
  const outsideMerge = [...REQUIRED_FORGE_OPERATIONS, ...TEST_VALUE_FORGE_OPERATIONS];
  expect(outsideMerge.filter(op => !used.includes(op))).toEqual([]);
});
