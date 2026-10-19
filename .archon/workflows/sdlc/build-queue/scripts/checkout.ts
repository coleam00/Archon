import { forgeSource, parseQualifiedPr } from '../../.shared/forge.ts';
import { checkoutPr } from '../../.shared/prepare-head.ts';
import { emit, refuse, trimmed } from '../../.shared/io.ts';

function main(): void {
  const continues = trimmed(process.env.INPUTS_CONTINUES);
  if (continues === '' || continues === 'null') {
    emit({ head: null });
    return;
  }
  const item = parseQualifiedPr(process.env.INPUTS_ITEM);
  const number = Number(continues);
  if (!Number.isInteger(number) || number <= 0) throw new Error('continues must be a positive PR number');
  const head = checkoutPr({ repo: item.repo, number }, forgeSource());
  emit({ head });
}

try {
  main();
} catch (error) {
  refuse(`build-queue checkout: ${error instanceof Error ? error.message : String(error)}`);
}
