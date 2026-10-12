import { linkPlatformIdentity, listUsersWithIdentities, setUserRole } from '@archon/core/db/users';
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
  const platformUserId = identity.slice(separator + 1);
  if (separator < 1 || !platform.success || !platformUserId.trim()) {
    throw new Error(
      'Expected <platform>:<platform-user-id> with a valid platform and non-empty id.'
    );
  }
  await linkPlatformIdentity(userId, platform.data, platformUserId, undefined, move);
  console.log(`${userId}\t${identity}`);
}
