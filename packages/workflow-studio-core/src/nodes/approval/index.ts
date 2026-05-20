import { approvalNodeSchema } from '../../schemas';
import { rewriteBodyRefs } from '../shared/renameBodyRefs';
import type { VariantDefinition } from '../shared/types';
import { ApprovalInspector } from './Inspector';
import {
  type ApprovalNodeData,
  createApprovalDefault,
  approvalCapabilities,
  approvalLibrary,
} from './data';
import { approvalFromDag } from './fromDag';
import { ApprovalRenderer } from './Renderer';
import { approvalToDag } from './toDag';

export type { ApprovalNodeData };

export const approvalVariant: VariantDefinition<ApprovalNodeData> = {
  id: 'approval',
  capabilities: approvalCapabilities,
  library: approvalLibrary,
  schema: approvalNodeSchema,
  createDefault: createApprovalDefault,
  fromDag: approvalFromDag,
  toDag: approvalToDag,
  Renderer: ApprovalRenderer,
  Inspector: ApprovalInspector,
  renameBodyRefs: (data, oldId, newId) => ({
    ...data,
    approval: {
      ...data.approval,
      message: rewriteBodyRefs(data.approval.message, oldId, newId),
    },
  }),
};
