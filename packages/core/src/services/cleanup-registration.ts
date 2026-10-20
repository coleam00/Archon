import {
  sameWorktreeRegistration,
  WorktreeRegistrationChangedError,
  type IsolationEnvironmentRow,
} from '@archon/isolation/types';
import { getById } from '../db/isolation-environments';

export async function getEnvironmentForRemoval(
  envId: string,
  observed?: IsolationEnvironmentRow
): Promise<IsolationEnvironmentRow | null> {
  const current = await getById(envId);
  if (current && observed && !sameWorktreeRegistration(current, observed)) {
    throw new WorktreeRegistrationChangedError(envId);
  }
  return current;
}
