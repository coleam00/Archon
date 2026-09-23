import { emit } from '../../.shared/io.ts';

const comparison = process.env.INPUTS_COMPARISON ?? '';
if (comparison !== '' && comparison.trim() === '') {
  throw new Error('Comparison path must not contain only whitespace.');
}
emit({ comparison: comparison !== '' });
