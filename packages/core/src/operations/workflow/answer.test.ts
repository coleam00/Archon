import { describe, expect, test } from 'bun:test';
import type {
  WorkflowAttentionWaitContext,
  WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import { attentionAnswerFor, RecommendationRefusedError } from './answer';

const run = { id: 'run-1' } as WorkflowRun;
type WaitFields = Partial<
  Pick<WorkflowAttentionWaitContext, 'other' | 'form' | 'options' | 'recommendation'>
>;
const wait = (fields: WaitFields): WorkflowAttentionWaitContext => ({
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

describe('accepting the recommendation', () => {
  const recommendation = { option: 'merge', why: 'Review is ready.' };
  const refusal = (fields: WaitFields, text?: string): RecommendationRefusedError => {
    try {
      attentionAnswerFor(run, wait(fields), { recommended: true, text });
    } catch (error) {
      if (error instanceof RecommendationRefusedError) return error;
      throw error;
    }
    throw new Error('Expected a refusal');
  };

  test('answers with the recommended option and carries the text', () => {
    expect(
      attentionAnswerFor(run, wait({ recommendation }), { recommended: true, text: 'Agreed.' })
    ).toEqual({ decision: 'merge', text: 'Agreed.' });
    expect(
      attentionAnswerFor(
        run,
        wait({
          form: 'approval',
          options: undefined,
          recommendation: { ...recommendation, option: 'reject' },
        }),
        { recommended: true }
      )
    ).toEqual({ decision: 'reject', text: '' });
  });

  test('is refused when the wait has no recommendation', () => {
    expect(refusal({})).toMatchObject({
      reason: 'none_recorded',
      message:
        "Run run-1's attention wait has no recommendation to accept. Choose one of its options.",
    });
  });

  test.each(['message', 'multi_select'] as const)('is refused on a %s wait', form => {
    expect(refusal({ form })).toMatchObject({
      reason: 'form_takes_none',
      message: `Run run-1's attention wait (form '${form}') takes no recommendation: only forms 'select' and 'approval' have one. Answer it in its form.`,
    });
  });

  test("is refused when the reserved 'other' option is recommended, even with text", () => {
    const fields = { other: true, recommendation: { ...recommendation, option: 'other' } } as const;
    expect(refusal(fields, 'Rebase first.')).toMatchObject({
      reason: 'recommends_other',
      message:
        "Run run-1's attention wait recommends the reserved option 'other', which needs text of its own. Choose 'other' and say what to do instead.",
    });
  });
});
