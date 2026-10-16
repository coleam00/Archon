import { settle } from '../../.shared/standalone.ts';
import { refuse } from '../../.shared/io.ts';

try {
  settle('deliver', {
    previous: process.env.INPUTS_PREVIOUS,
    effect: process.env.INPUTS_EFFECT,
    result: process.env.INPUTS_RESULT,
    decision: process.env.INPUTS_DECISION,
    plan: process.env.INPUTS_PLAN,
    replan: process.env.INPUTS_REPLAN,
  });
} catch (error) {
  refuse(error instanceof Error ? error.message : String(error));
}
