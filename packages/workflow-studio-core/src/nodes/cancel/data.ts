import type { VariantCapabilities, VariantLibraryMetadata } from '../shared/types';

export interface CancelNodeData {
  /** Reason string shown when the workflow run is cancelled. */
  cancel: string;
}

export function createCancelDefault(): CancelNodeData {
  return { cancel: '' };
}

export const cancelCapabilities: VariantCapabilities = {
  honorsAiFields: false,
  forbidsRetry: false,
};

export const cancelLibrary: VariantLibraryMetadata = {
  label: 'Cancel',
  description: 'Terminate the workflow with a reason',
  colorToken: 'node-cancel',
  iconName: 'XOctagon',
  defaultIdHint: 'cancel',
};
