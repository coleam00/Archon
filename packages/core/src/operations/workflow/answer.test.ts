import { describe, expect, test } from 'bun:test';
import type {
  WorkflowAttentionWaitContext,
  WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import { attentionAnswerFor } from './answer';

const run = { id: 'run-1' } as WorkflowRun;
const wait = (fields: { other?: true }): WorkflowAttentionWaitContext => ({
  owner: 'node',
  nodeId: 'ask',
  kind: 'attention',
  waitingSince: '2026-08-24T10:00:00.000Z',
  message: 'Merge it?',
  pauseId: 'ask-1',
  form: 'select',
  options: [{ id: 'merge' }, { id: 'other' }],
  ...fields,
});

describe("answering a select wait's reserved 'other' option", () => {
  test.each([undefined, '', '  \n'])('refuses it without text (%p)', text => {
    expect(() =>
      attentionAnswerFor(run, wait({ other: true }), { choose: ['other'], text })
    ).toThrow("needs text with option 'other'");
  });

  test('records it with its text', () => {
    expect(
      attentionAnswerFor(run, wait({ other: true }), { choose: ['other'], text: 'Rebase first.' })
    ).toEqual({ decision: 'other', text: 'Rebase first.' });
  });

  test('asks no text of the declared options, or of a wait that only names an option other', () => {
    expect(attentionAnswerFor(run, wait({ other: true }), { choose: ['merge'] })).toEqual({
      decision: 'merge',
      text: '',
    });
    expect(attentionAnswerFor(run, wait({}), { choose: ['other'] })).toEqual({
      decision: 'other',
      text: '',
    });
  });
});
