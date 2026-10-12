import {
  linkPlatformIdentity,
  listUsersWithIdentities,
  PlatformIdentityConflictError,
  setUserRole,
} from '@archon/core/db/users';
import { identityPlatformSchema, userRoleSchema } from '@archon/core/schemas/user';

export async function userListCommand(): Promise<void> {
  const users = await listUsersWithIdentities();
  if (users.length === 0) {
    console.log('No users found.');
    return;
  }
  console.log('ID\tROLE\tDISPLAY NAME\tIDENTITIES');
  for (const user of users) {
    const identities = user.identities
      .map(identity => `${identity.platform}:${identity.platform_user_id}`)
      .join(', ');
    console.log(`${user.id}\t${user.role}\t${user.display_name ?? '-'}\t${identities || '-'}`);
  }
}

export async function userRoleCommand(userId: string, role: string): Promise<void> {
  const parsed = userRoleSchema.safeParse(role);
  if (!parsed.success) {
    throw new Error(`Invalid role: ${role}. Expected ${userRoleSchema.options.join(' or ')}.`);
  }
  await setUserRole(userId, parsed.data);
  console.log(`${userId}\t${parsed.data}`);
}

export async function userLinkCommand(
  userId: string,
  identity: string,
  move: boolean
): Promise<void> {
  const separator = identity.indexOf(':');
  const platform = identityPlatformSchema.safeParse(identity.slice(0, separator));
  // Stored ids are matched exactly, so stray whitespace would create an identity no adapter sends.
  const platformUserId = identity.slice(separator + 1).trim();
  if (separator < 1 || !platform.success || !platformUserId) {
    throw new Error(
      'Expected <platform>:<platform-user-id> with a valid platform and non-empty id.'
    );
  }
  try {
    await linkPlatformIdentity(userId, platform.data, platformUserId, undefined, move);
  } catch (error) {
    if (error instanceof PlatformIdentityConflictError) {
      throw new Error(`${error.message} Pass --move to move it.`, { cause: error });
    }
    throw error;
  }
  console.log(`${userId}\t${platform.data}:${platformUserId}`);
}
