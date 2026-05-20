import type { LoopNodeConfig } from '../../schemas';
import type { VariantCapabilities, VariantLibraryMetadata } from '../shared/types';

export interface LoopNodeData {
  /** The full loop config — preserved verbatim, including any foreign sub-keys. */
  loop: LoopNodeConfig & Record<string, unknown>;
}

export function createLoopDefault(): LoopNodeData {
  return {
    loop: {
      prompt: '',
      until: 'COMPLETE',
      max_iterations: 10,
      fresh_context: false,
    } as LoopNodeData['loop'],
  };
}

export const loopCapabilities: VariantCapabilities = {
  honorsAiFields: true,
  forbidsRetry: true,
};

export const loopLibrary: VariantLibraryMetadata = {
  label: 'Loop',
  description: 'AI prompt looped until completion signal',
  colorToken: 'node-loop',
  iconName: 'RefreshCw',
  defaultIdHint: 'loop',
};
