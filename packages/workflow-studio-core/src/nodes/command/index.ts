import { commandNodeSchema } from '../../schemas';
import type { VariantDefinition } from '../shared/types';
import { CommandInspector } from './Inspector';
import {
  type CommandNodeData,
  createCommandDefault,
  commandCapabilities,
  commandLibrary,
} from './data';
import { commandFromDag } from './fromDag';
import { CommandRenderer } from './Renderer';
import { commandToDag } from './toDag';

export type { CommandNodeData };

export const commandVariant: VariantDefinition<CommandNodeData> = {
  id: 'command',
  capabilities: commandCapabilities,
  library: commandLibrary,
  schema: commandNodeSchema,
  createDefault: createCommandDefault,
  fromDag: commandFromDag,
  toDag: commandToDag,
  Renderer: CommandRenderer,
  Inspector: CommandInspector,
  // command has no free-form body text — no renameBodyRefs slot.
};
