import { describe, expect, test } from 'bun:test';
import { factoryRunStory } from './factory-item-story';
import { runFixture, shippedView } from './factory-test.test-helpers';

const view = shippedView();
/** Item 111's one deliver run (see the file's `note`). */
const { run, events } = runFixture('factory-items', 'item-111-deliver-aba8f7aa');

describe('factoryRunStory', () => {
  const story = factoryRunStory(view, run, events);

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
    expect(factoryRunStory(why, run, events).said).toStartWith('PR #112 is clear.');
    const none = { ...view, story: { outcomes: {}, said: ['/why'] } };
    expect(factoryRunStory(none, run, events).said).toBeNull();
  });

  test('a view with no story reads nothing said; a run still going has no result to read', () => {
    const { story: _story, ...bare } = view;
    expect(factoryRunStory(bare, run, events).said).toBeNull();
    const running = { ...run, status: 'running' as const, completed_at: null };
    expect(factoryRunStory(view, running, events).said).toBeNull();
  });
});
