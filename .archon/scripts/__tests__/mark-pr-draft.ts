import { forgeSource, parseQualifiedPr } from '../../workflows/sdlc/.shared/forge.ts';
import { setPrDraft } from '../../workflows/sdlc/.shared/pr.ts';
import { emit, refuse } from '../../workflows/sdlc/.shared/io.ts';

try {
  emit(setPrDraft(parseQualifiedPr(process.env.INPUTS_PR), true, forgeSource()));
} catch (error) {
  refuse(error instanceof Error ? error.message : String(error));
}
