import { listUsersWithIdentities, setUserRole } from '@archon/core/db/users';
import { userRoleSchema } from '@archon/core/schemas/user';

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
