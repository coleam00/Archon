import { loopNodeSchema } from '../../schemas';
import { rewriteBodyRefs } from '../shared/renameBodyRefs';
import type { VariantDefinition } from '../shared/types';
import { LoopInspector } from './Inspector';
import { type LoopNodeData, createLoopDefault, loopCapabilities, loopLibrary } from './data';
import { loopFromDag } from './fromDag';
import { LoopRenderer } from './Renderer';
import { loopToDag } from './toDag';

export type { LoopNodeData };

export const loopVariant: VariantDefinition<LoopNodeData> = {
  id: 'loop',
  capabilities: loopCapabilities,
  library: loopLibrary,
  schema: loopNodeSchema,
  createDefault: createLoopDefault,
  fromDag: loopFromDag,
  toDag: loopToDag,
  Renderer: LoopRenderer,
  Inspector: LoopInspector,
  renameBodyRefs: (data, oldId, newId) => ({
    ...data,
    loop: {
      ...data.loop,
      prompt: rewriteBodyRefs(data.loop.prompt, oldId, newId),
    },
  }),
};
