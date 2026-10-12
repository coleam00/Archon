import { emit, refuse } from '../../.shared/io.ts';

try {
  const continuation = process.env.INPUTS_CONTINUATION;
  if (continuation !== 'true' && continuation !== 'false') {
    throw new Error('continuation must be a boolean');
  }
  const tier = process.env.INPUTS_TIER;
  if (continuation === 'true') {
    emit({ full: false });
  } else if (tier !== 'focused') {
    if (tier === undefined) throw new Error('tier is missing');
    emit({ full: true });
  } else {
    const focused: unknown = JSON.parse(process.env.INPUTS_FOCUSED ?? 'null');
    if (
      typeof focused !== 'object' ||
      focused === null ||
      !('full_review' in focused) ||
      typeof focused.full_review !== 'boolean' ||
      !('reason' in focused) ||
      typeof focused.reason !== 'string' ||
      focused.reason.trim() === ''
    ) {
      throw new Error('enabled focused review must declare full_review and a nonempty reason');
    }
    emit({ full: focused.full_review });
  }
} catch (error) {
  refuse(`resolve-review-coverage: ${error instanceof Error ? error.message : String(error)}`);
}
