/**
 * The ask card enables Confirm exactly when the engine would accept the answer (DESIGN.md,
 * Visual standard rule 9). The engine's rule is `attentionAnswerProblem` in `@archon/workflows`;
 * `@archon/web` must not import `@archon/workflows`, so the card holds a copy
 * (`answerProblem` in the console's `lib/ask-card.ts`), and this test keeps the two in step: for
 * every form and every answer shape below, both accept or both refuse. It lives in `scripts/`
 * for the reason `node-ref-parity.test.ts` gives: it is a cross-package invariant.
 */
import { describe, expect, test } from 'bun:test';
import {
  answerProblem,
  type AttentionWait,
} from '../packages/web/src/experiments/console/lib/ask-card';
import { attentionAnswerProblem } from '../packages/workflows/src/schemas/run-wait';
import { APPROVAL_ATTENTION_OPTIONS } from '../packages/workflows/src/schemas/wait-node';

const select = [{ id: 'use-main' }, { id: 'use-dev' }];
const withOther = [...select, { id: 'other', label: 'Other' }];

/** What both rules read of a wait; option values never matter to whether an answer is accepted. */
type Wait = Pick<AttentionWait, 'form' | 'other'> & { options: { id: string; label?: string }[] };

/** Each wait as the queue sends it: approval carries the engine's options, as `attentionOptions` fills them. */
const WAITS: Record<string, Wait> = {
  message: { form: 'message', options: [] },
  approval: { form: 'approval', options: APPROVAL_ATTENTION_OPTIONS.map(({ id }) => ({ id })) },
  select: { form: 'select', options: select },
  'select with other': { form: 'select', options: withOther, other: true },
  multi: { form: 'multi_select', options: select },
  'multi with other': { form: 'multi_select', options: withOther, other: true },
};

const CHOICES: readonly (readonly string[])[] = [
  [],
  ['approve'],
  ['reject'],
  ['use-main'],
  ['use-dev'],
  ['use-main', 'use-dev'],
  ['use-main', 'use-main'],
  ['other'],
  ['use-dev', 'other'],
  ['nope'],
];
const TEXTS = ['', '   ', 'Do it on dev instead.'];

describe('the ask card accepts an answer exactly when the engine does', () => {
  for (const [name, wait] of Object.entries(WAITS)) {
    test(name, () => {
      for (const choose of CHOICES)
        for (const text of TEXTS) {
          const engine = attentionAnswerProblem(wait, { choose, text }) === undefined;
          const card = answerProblem(wait, { choose, text }) === undefined;
          expect({ choose, text, accepted: card }).toEqual({ choose, text, accepted: engine });
        }
    });
  }
});
