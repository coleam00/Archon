import { emit, trimmed } from '../../.shared/io.ts';

emit({ comparison: trimmed(process.env.INPUTS_COMPARISON) !== '' });
