import { scriptNodeSchema } from '../../schemas';
import { rewriteBodyRefs } from '../shared/renameBodyRefs';
import type { VariantDefinition } from '../shared/types';
import { ScriptInspector } from './Inspector';
import {
  type ScriptNodeData,
  createScriptDefault,
  scriptCapabilities,
  scriptLibrary,
} from './data';
import { scriptFromDag } from './fromDag';
import { ScriptRenderer } from './Renderer';
import { scriptToDag } from './toDag';

export type { ScriptNodeData };

export const scriptVariant: VariantDefinition<ScriptNodeData> = {
  id: 'script',
  capabilities: scriptCapabilities,
  library: scriptLibrary,
  schema: scriptNodeSchema,
  createDefault: createScriptDefault,
  fromDag: scriptFromDag,
  toDag: scriptToDag,
  Renderer: ScriptRenderer,
  Inspector: ScriptInspector,
  renameBodyRefs: (data, oldId, newId) => ({
    ...data,
    script: rewriteBodyRefs(data.script, oldId, newId),
  }),
};
