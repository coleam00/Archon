// Wire identifiers shared by metadata and operation validation.
export const FORGE_PROTOCOL_VERSION = 1;
// resolve is the protocol's root operation; forge operations use dotted names.
export const RESOLVE_OP = 'resolve';
export const CHECKS_STATE_OP = 'checks.state';
export const PUBLIC_OPS = {
  prView: 'pr.view',
  prCreate: 'pr.create',
  prEditBody: 'pr.edit-body',
  prReady: 'pr.ready',
  workItemView: 'workitem.view',
  commentUpsert: 'comment.upsert',
} as const;
