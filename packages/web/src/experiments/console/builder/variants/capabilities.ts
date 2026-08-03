/**
 * Per-variant capability flags. Describe how each variant relates to AI fields,
 * retry, and interactivity so the editor (PR-2) can gate UI affordances. Mirrors
 * the engine's runtime semantics (e.g. retry is rejected on loop nodes).
 */
import type { VariantId } from '../types';

export interface VariantCapabilities {
  /** Whether the variant invokes a provider and so honors AI fields (model, tools, …). */
  honorsAiFields: boolean;
  /** Loop nodes manage their own iteration; the engine rejects `retry` on them. */
  forbidsRetry?: boolean;
  /** Approval nodes require the workflow to run interactively (foreground). */
  requiresInteractive?: boolean;
}

export const VARIANT_CAPABILITIES: Record<VariantId, VariantCapabilities> = {
  prompt: { honorsAiFields: true },
  command: { honorsAiFields: true },
  // Loop forwards model/provider to each iteration's AI call but rejects retry.
  loop: { honorsAiFields: true, forbidsRetry: true },
  // Approval is a human gate; it makes no provider call (no AI fields) and
  // requires interactive mode because it pauses the run for human input.
  approval: { honorsAiFields: false, requiresInteractive: true },
  // bash/script/cancel make no provider call — AI fields are meaningless on them.
  bash: { honorsAiFields: false },
  script: { honorsAiFields: false },
  cancel: { honorsAiFields: false },
};
