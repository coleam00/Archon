// Wire identifiers shared by metadata and operation validation.
export const FORGE_PROTOCOL_VERSION = 1;
// resolve is the protocol's root operation; forge operations use dotted names.
export const RESOLVE_OP = 'resolve';
export const CHECKS_STATE_OP = 'checks.state';

export const PINNED_MERGE_OP = 'pr.merge-pinned';
export const PUBLIC_OP = {
  viewPr: 'pr.view',
  createPr: 'pr.create',
  editPrBody: 'pr.edit-body',
  readyPr: 'pr.ready',
  viewWorkItem: 'workitem.view',
  upsertComment: 'comment.upsert',
} as const;
export type PublicOp = (typeof PUBLIC_OP)[keyof typeof PUBLIC_OP];
