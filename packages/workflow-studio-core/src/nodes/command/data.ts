import type { VariantCapabilities, VariantLibraryMetadata } from '../shared/types';

export interface CommandNodeData {
  /** The command name (matches a file in .archon/commands/). */
  command: string;
}

export function createCommandDefault(): CommandNodeData {
  return { command: '' };
}

export const commandCapabilities: VariantCapabilities = {
  honorsAiFields: true,
  forbidsRetry: false,
};

export const commandLibrary: VariantLibraryMetadata = {
  label: 'Command',
  description: 'Run a named command from `.archon/commands/`',
  colorToken: 'node-command',
  iconName: 'Terminal',
  defaultIdHint: 'run-command',
};
