import { checkoutPr } from '../../.shared/prepare-head.ts';
import { forgeSource, parseQualifiedPr } from '../../.shared/forge.ts';
import { emit, nullableJson, refuse } from '../../.shared/io.ts';

try {
  const number = nullableJson(process.env.INPUTS_PULL_REQUEST);
  if (number === null) {
    emit({ head: null });
  } else {
    const ref = parseQualifiedPr(process.env.INPUTS_REF);
    if (ref.number !== number) throw new Error('resolved PR differs from the continuation');
    emit({ head: checkoutPr(ref, forgeSource(), true) });
  }
} catch (error) {
  refuse(`ship checkout: ${error instanceof Error ? error.message : String(error)}`);
}
