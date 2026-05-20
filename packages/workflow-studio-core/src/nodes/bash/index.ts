import { bashNodeSchema } from '../../schemas';
import { rewriteBodyRefs } from '../shared/renameBodyRefs';
import type { VariantDefinition } from '../shared/types';
import { BashInspector } from './Inspector';
import { type BashNodeData, createBashDefault, bashCapabilities, bashLibrary } from './data';
import { bashFromDag } from './fromDag';
import { BashRenderer } from './Renderer';
import { bashToDag } from './toDag';

export type { BashNodeData };

export const bashVariant: VariantDefinition<BashNodeData> = {
  id: 'bash',
  capabilities: bashCapabilities,
  library: bashLibrary,
  schema: bashNodeSchema,
  createDefault: createBashDefault,
  fromDag: bashFromDag,
  toDag: bashToDag,
  Renderer: BashRenderer,
  Inspector: BashInspector,
  renameBodyRefs: (data, oldId, newId) => ({
    ...data,
    bash: rewriteBodyRefs(data.bash, oldId, newId),
  }),
};
