import { forgeSource, parseQualifiedPr } from '../../workflows/sdlc/.shared/forge.ts';
import { markPrDraft } from '../../workflows/sdlc/.shared/pr.ts';
import { emit, refuse } from '../../workflows/sdlc/.shared/io.ts';

try {
  emit(markPrDraft(parseQualifiedPr(process.env.INPUTS_PR), forgeSource()));
} catch (error) {
  refuse(error instanceof Error ? error.message : String(error));
}
