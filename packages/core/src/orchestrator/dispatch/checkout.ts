import { CheckoutReleasedError } from '@archon/workflows/schemas/checkout-ownership';
import * as sqlIsolation from '../../db/isolation-environments';
import { clearConversationCheckout } from '../../db/conversations';
import type { DispatchScope } from './scope';

export async function reconcileFreshCheckout(scope: DispatchScope): Promise<DispatchScope> {
  if (!scope.conversation.isolation_env_id) return scope;
  const environment = await sqlIsolation.getById(scope.conversation.isolation_env_id);
  if (environment?.provider !== 'worktree' || environment.status !== 'destroyed') return scope;
  const conversation = await clearConversationCheckout(scope.conversation.id, environment.id);
  const currentEnvironment = conversation.isolation_env_id
    ? await sqlIsolation.getById(conversation.isolation_env_id)
    : undefined;
  if (currentEnvironment?.status === 'destroyed')
    throw new CheckoutReleasedError(currentEnvironment.working_path);
  return {
    ...scope,
    conversation,
    runCwd: conversation.cwd ?? currentEnvironment?.working_path ?? scope.codebase.default_cwd,
  };
}
