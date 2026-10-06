import type { UserRole } from '../schemas/user';

export type RunActor =
  | { kind: 'operator' }
  | { kind: 'user'; userId: string }
  | { kind: 'unidentified' };

export const RUN_ACTIONS = [
  'approve',
  'reject',
  'respond',
  'cancel',
  'abandon',
  'resume',
  'signal',
  'delete',
] as const;

export type RunAction = (typeof RUN_ACTIONS)[number];

export function authorizeRunAction(
  actor: RunActor,
  starterUserId: string | null,
  actorRole: UserRole | undefined
): boolean {
  return (
    actor.kind === 'operator' ||
    (actor.kind === 'user' && (actorRole === 'admin' || actor.userId === starterUserId))
  );
}

export class RunActionForbiddenError extends Error {
  constructor(
    readonly action: RunAction,
    starterUserId: string | null | undefined
  ) {
    const verb = action === 'respond' ? 'respond to' : action;
    super(
      (starterUserId === null
        ? `This run has no recorded starter; only an admin can ${verb} it.`
        : `Only the user who started this run or an admin can ${verb} it.`) +
        ' An operator can grant admin with `archon user role <user-id> admin`.'
    );
    this.name = 'RunActionForbiddenError';
  }
}
