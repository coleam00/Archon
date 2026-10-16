import { prepare } from '../../.shared/standalone.ts';
import { refuse } from '../../.shared/io.ts';

try {
  prepare(process.env.INPUTS_PREVIOUS, process.env.INPUTS_ANSWER, process.env.INPUTS_WORK);
} catch (error) {
  refuse(error instanceof Error ? error.message : String(error));
}
