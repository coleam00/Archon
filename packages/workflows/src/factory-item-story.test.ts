import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRunFixture } from './__fixtures__/read-run-fixture';
import { factoryRunStory } from './factory-item-story';
import { factoryViewSchema } from './schemas/factory-view';
import { workflowRunSchema, type WorkflowRun } from './schemas/workflow-run';

const view = factoryViewSchema.parse(
  JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        '../../../.archon/packs/Wirasm.archon-software-factory.factory-view.json'
      ),
      'utf8'
    )
  )
);

/** Item 111's one deliver run (see the file's `note`). */
const raw = readRunFixture(
  join(import.meta.dir, '__fixtures__', 'factory-items', 'item-111-deliver-aba8f7aa.jsonl')
) as ReturnType<typeof readRunFixture> & {
  run: Record<string, unknown> & { started_at: string; completed_at: string };
};

const run: WorkflowRun = workflowRunSchema.parse({
  origin: null,
  conversation_id: null,
  parent_conversation_id: null,
  codebase_id: null,
  outcome: null,
  completed_outcome: null,
  user_message: '',
  active_phase_started_at: null,
  last_activity_at: null,
  working_path: null,
  user_id: null,
  parent_run_id: null,
  adopted_from_run_id: null,
  output_root: null,
  checkout_baseline: null,
  item_id: null,
  metadata: {},
  ...raw.run,
  started_at: new Date(raw.run.started_at),
  completed_at: new Date(raw.run.completed_at),
});

describe('factoryRunStory', () => {
  const story = factoryRunStory(view, run, raw.events);

  test('lists each step start in event order, as UTC ISO times', () => {
    const nodes = story.steps.map(step => step.node);
    expect(nodes.slice(0, 3)).toEqual(['build__build', 'rounds', 'rounds.base']);
    // The fix sits between the two rounds, and CI and the reviews come after them.
    expect(nodes.filter(node => node === 'rounds.base')).toHaveLength(2);
    expect(nodes.indexOf('rounds.fix')).toBeGreaterThan(nodes.indexOf('rounds.verdict__verdict'));
    expect(nodes.indexOf('hostrounds.host__host')).toBeGreaterThan(
      nodes.lastIndexOf('rounds.base')
    );
    expect(story.steps[0]).toEqual({ node: 'build__build', startedAt: '2026-11-20T20:30:57.000Z' });
  });

  test('lists the distinct models its steps ran on, first recorded first', () => {
    expect(story.models).toEqual(['claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5']);
  });

  test("reads what the run said at the view's first said pointer that holds a string", () => {
    expect(story.said).toStartWith('PR #112 is clear.');
    const why = { ...view, story: { outcomes: {}, said: ['/why', '/summary'] } };
    expect(factoryRunStory(why, run, raw.events).said).toStartWith('PR #112 is clear.');
    const none = { ...view, story: { outcomes: {}, said: ['/why'] } };
    expect(factoryRunStory(none, run, raw.events).said).toBeNull();
  });

  test('a view with no story reads nothing said; a run still going has no result to read', () => {
    const { story: _story, ...bare } = view;
    expect(factoryRunStory(bare, run, raw.events).said).toBeNull();
    const running = { ...run, status: 'running' as const, completed_at: null };
    expect(factoryRunStory(view, running, raw.events).said).toBeNull();
  });
});
