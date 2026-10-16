import { settle } from '../../.shared/standalone.ts';
import { refuse } from '../../.shared/io.ts';

try {
  settle('ship', {
    previous: process.env.INPUTS_PREVIOUS,
    effect: process.env.INPUTS_EFFECT,
    result: process.env.INPUTS_RESULT,
    decision: process.env.INPUTS_DECISION,
  });
} catch (error) {
  refuse(error instanceof Error ? error.message : String(error));
}
