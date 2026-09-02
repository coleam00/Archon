/**
 * `archon conversations` — the upgrade path for an install that turns web auth
 * on (#3135).
 *
 * Operator conversations are private to their owning user, and ownership is
 * fail-closed: a row Archon cannot attribute is reachable by nobody over the
 * web API. Every conversation written before enforcement has `user_id IS NULL`,
 * so switching auth on hides the whole history behind a boundary with no owner
 * to authenticate against. These two commands are the documented way back.
 *
 *   archon conversations list --unowned [--platform web|cli]
 *   archon conversations claim --user <archon-user-id> [--platform …] [--before <iso>] [--dry-run] [--yes]
 *
 * The claim belongs to the shell, not to the console. An unowned row has no
 * owner to authenticate against, so "claim" over HTTP would mean the first user
 * to click takes everyone else's history on a shared install. Shell access is
 * the strongest available assertion of "I run this install", and it already
 * implies database access.
 *
 * The safety of the whole surface is one clause in the WHERE — `user_id IS
 * NULL` — not a check here: claiming can never move a row between two real
 * users, so a second operator running the same command takes nothing the first
 * one already took.
 */
import * as conversationDb from '@archon/core/db/conversations';
import * as workflowDb from '@archon/core/db/workflows';
import * as userDb from '@archon/core/db/users';
import type { Conversation } from '@archon/core/types';

/** Default rows shown by `list --unowned` before the output is truncated. */
const DEFAULT_LIST_LIMIT = 20;

export interface ConversationsListOptions {
  unowned?: boolean;
  platform?: string;
  limit?: string;
}

export interface ConversationsClaimOptions {
  user?: string;
  platform?: string;
  before?: string;
  dryRun?: boolean;
  yes?: boolean;
}

/** Either the resolved value or the message to print before exiting 1. */
type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Which surfaces the operator asked for. Restricted to the platforms privacy
 * actually covers: stamping an owner on a Slack or GitHub conversation would
 * change nothing about who can read it, but it WOULD decide who may act on the
 * runs dispatched from it.
 */
function resolvePlatforms(platform: string | undefined): Resolved<readonly string[]> {
  if (platform === undefined) return { ok: true, value: conversationDb.PRIVATE_PLATFORM_TYPES };
  if (!conversationDb.isPrivatePlatformType(platform)) {
    return {
      ok: false,
      error:
        `Unsupported --platform '${platform}'.\n` +
        `Ownership only applies to operator surfaces: ${conversationDb.PRIVATE_PLATFORM_TYPES.join(', ')}.`,
    };
  }
  return { ok: true, value: [platform] };
}

function resolveBefore(before: string | undefined): Resolved<Date | undefined> {
  if (before === undefined) return { ok: true, value: undefined };
  const parsed = new Date(before);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, error: `Invalid --before '${before}'. Use an ISO date, e.g. 2026-01-31.` };
  }
  return { ok: true, value: parsed };
}

function resolveLimit(limit: string | undefined): Resolved<number> {
  if (limit === undefined) return { ok: true, value: DEFAULT_LIST_LIMIT };
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, error: `Invalid --limit '${limit}'. Use a positive integer.` };
  }
  return { ok: true, value: parsed };
}

/**
 * Rows arrive straight from `SELECT *`, so a timestamp is a Date on Postgres
 * and the stored text on SQLite. Print whichever shape it is instead of
 * pretending the column has one type.
 */
function formatTimestamp(value: Date | string | null): string {
  if (!value) return '-';
  return value instanceof Date ? value.toISOString().replace('T', ' ').slice(0, 19) : value;
}

function printConversationTable(rows: readonly Conversation[]): void {
  const idWidth = Math.max(2, ...rows.map(row => row.platform_conversation_id.length));
  const platformWidth = Math.max(8, ...rows.map(row => row.platform_type.length));
  console.log(
    `${'PLATFORM'.padEnd(platformWidth)}  ${'ID'.padEnd(idWidth)}  ${'LAST ACTIVITY'.padEnd(19)}  TITLE`
  );
  for (const row of rows) {
    const title = row.title ?? (row.hidden ? '(workflow worker conversation)' : '(no title)');
    console.log(
      `${row.platform_type.padEnd(platformWidth)}  ${row.platform_conversation_id.padEnd(idWidth)}  ` +
        `${formatTimestamp(row.last_activity_at).padEnd(19)}  ${title}`
    );
  }
}

/**
 * `archon conversations list --unowned` — show exactly what a claim would take,
 * before taking it.
 */
export async function conversationsListCommand(options: ConversationsListOptions): Promise<number> {
  if (!options.unowned) {
    console.error(
      'Usage: archon conversations list --unowned [--platform web|cli] [--limit <n>]\n' +
        'Only the unowned view exists: it reports conversations no Archon user owns,\n' +
        'which are the ones an install that turned web auth on can no longer reach.'
    );
    return 1;
  }

  const platforms = resolvePlatforms(options.platform);
  if (!platforms.ok) {
    console.error(platforms.error);
    return 1;
  }
  const limit = resolveLimit(options.limit);
  if (!limit.ok) {
    console.error(limit.error);
    return 1;
  }

  const rows = await conversationDb.listOwnerlessConversations({
    platformTypes: platforms.value,
  });

  if (rows.length === 0) {
    console.log(`No unowned conversations on ${platforms.value.join('/')}.`);
    return 0;
  }

  const shown = rows.slice(0, limit.value);
  console.log(
    `${String(rows.length)} unowned ${platforms.value.join('/')} conversation${rows.length === 1 ? '' : 's'}` +
      (shown.length < rows.length ? ` (showing ${String(shown.length)}):` : ':')
  );
  console.log('');
  printConversationTable(shown);
  console.log('');
  console.log('Claim them with: archon conversations claim --user <archon-user-id>');
  console.log('Your own id: copy it from console Settings (the remote_agent_users id).');
  return 0;
}

/**
 * `archon conversations claim` — attach unowned conversations and runs to one
 * Archon user.
 *
 * Deliberately not filtered by "conversations I started": that information does
 * not exist for an unowned row, which is the entire problem being solved.
 */
export async function conversationsClaimCommand(
  options: ConversationsClaimOptions
): Promise<number> {
  if (!options.user) {
    console.error(
      'Usage: archon conversations claim --user <archon-user-id> [--platform web|cli] [--before <iso>] [--dry-run] [--yes]\n' +
        'Find the id in console Settings (the remote_agent_users id).'
    );
    return 1;
  }

  const platforms = resolvePlatforms(options.platform);
  if (!platforms.ok) {
    console.error(platforms.error);
    return 1;
  }
  const before = resolveBefore(options.before);
  if (!before.ok) {
    console.error(before.error);
    return 1;
  }

  // Resolve the target first: a typo would otherwise strand every claimed row
  // on a user that does not exist, which is harder to notice than a refusal.
  const user = await userDb.getUserById(options.user);
  if (!user) {
    console.error(
      `No Archon user with id '${options.user}'.\n` +
        'The target is a remote_agent_users id — copy it from console Settings.\n' +
        'It is not your login email or your CLI identity.'
    );
    return 1;
  }

  const filter = { platformTypes: platforms.value, before: before.value };
  const [conversations, runs] = await Promise.all([
    conversationDb.listOwnerlessConversations(filter),
    workflowDb.countOwnerlessRuns(user.id, filter),
  ]);

  const who = user.display_name ? `${user.display_name} (${user.id})` : user.id;
  console.log(
    `Unowned on ${platforms.value.join('/')}${options.before ? ` before ${options.before}` : ''}:`
  );
  console.log(`  conversations: ${String(conversations.length)}`);
  console.log(`  workflow runs: ${String(runs)}`);

  if (conversations.length === 0 && runs === 0) {
    console.log(`\nNothing to claim for ${who}.`);
    return 0;
  }

  if (options.dryRun) {
    console.log('\n--dry-run: nothing was written.');
    return 0;
  }

  if (!options.yes) {
    console.error(
      `\nRefusing to assign ownership of these rows to ${who} without confirmation.\n` +
        'Re-run with --yes to apply, or --dry-run to preview without writing.'
    );
    return 1;
  }

  const claimedConversations = await conversationDb.claimOwnerlessConversations(user.id, filter);
  const claimedRuns = await workflowDb.claimOwnerlessRuns(user.id, filter);

  console.log(
    `\nClaimed ${String(claimedConversations)} conversation${claimedConversations === 1 ? '' : 's'} ` +
      `and ${String(claimedRuns)} workflow run${claimedRuns === 1 ? '' : 's'} for ${who}.`
  );
  console.log(
    'Rows that already had an owner were not touched, so another operator can run\n' +
      'this for their own share of what is still unowned.'
  );
  return 0;
}
