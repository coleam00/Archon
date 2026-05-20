import { cancelNodeSchema } from '../../schemas';
import type { VariantDefinition } from '../shared/types';
import { CancelInspector } from './Inspector';
import {
  type CancelNodeData,
  createCancelDefault,
  cancelCapabilities,
  cancelLibrary,
} from './data';
import { cancelFromDag } from './fromDag';
import { CancelRenderer } from './Renderer';
import { cancelToDag } from './toDag';

export type { CancelNodeData };

export const cancelVariant: VariantDefinition<CancelNodeData> = {
  id: 'cancel',
  capabilities: cancelCapabilities,
  library: cancelLibrary,
  schema: cancelNodeSchema,
  createDefault: createCancelDefault,
  fromDag: cancelFromDag,
  toDag: cancelToDag,
  Renderer: CancelRenderer,
  Inspector: CancelInspector,
  // cancel has no free-form body text — no renameBodyRefs slot.
};
