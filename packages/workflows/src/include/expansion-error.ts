import type { WorkflowLoadError } from '../schemas';

/** Internal signal for a per-workflow expansion failure (resilient: drop one, keep the rest). */
export class IncludeExpansionError extends Error {
  constructor(
    message: string,
    readonly errorType: WorkflowLoadError['errorType'] = 'validation_error',
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}
