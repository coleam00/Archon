/**
 * What the SDLC pack still states about the forge contract by hand: its close reasons, and
 * the forge operations it declares as its needs in `.pack/pack.yaml`. The pack's forge
 * calls themselves are typed by `archon:script`.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeReasonSchema, mutationOperationSchema } from '../packages/forge/src/lifecycle';
import { type ForgeRequest, forgeRequestSchema } from '../packages/forge/src/operations';
import { CLOSE_REASONS } from '../.archon/workflows/sdlc/.shared/issue';

test('every reason the pack closes an issue with is a forge close reason', () => {
  for (const reason of CLOSE_REASONS) expect(closeReasonSchema.parse(reason)).toBe(reason);
});

/**
 * Reads only an agent calls, from a prompt. The pack does not declare them: nothing a run
 * writes depends on one, the host refuses the call by name (`unsupported_op`) on a
 * plugin without it, and the prompt has the agent report that refusal. Declaring one
 * would instead refuse every pack run, on a plugin that can make every write, for a
 * log read only a red check needs. A script that calls one must declare it, so each
 * must stay out of every pack script.
 */
const AGENT_READ_OPERATIONS: readonly ForgeRequest['op'][] = ['workitem.search', 'checks.logs'];

test('the forge needs the pack declares are the forge operations it calls', () => {
  const root = join(import.meta.dir, '../.archon/workflows/sdlc');
  const sources = [...new Bun.Glob('**/*.{ts,md}').scanSync({ cwd: root, dot: true })]
    // The setup guide names operations in examples an operator runs, not in calls the pack makes.
    .filter(file => file !== 'README.md')
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
    // `resolve` is not declared: a workflow calls it first, only when its repo inputs
    // are empty, so the host's refusal already comes before any spend.
    .filter(op => op !== 'resolve');
  expect(used).toContain('checks.state');
  // The build queue's any-state lookup (`pr.view:any-state`) is not declared either: the
  // host refuses it on a plugin without the capability, naming it.
  const pack = Bun.YAML.parse(readFileSync(join(root, '.pack/pack.yaml'), 'utf8')) as {
    forge: { operations: string[] };
  };
  expect([...pack.forge.operations].sort()).toEqual([...used].sort());
});
