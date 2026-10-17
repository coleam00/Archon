import type { Context } from 'hono';
import type { Conversation, RunActor, User } from '@archon/core';
import * as conversationDb from '@archon/core/db/conversations';
import {
  isConversationVisible,
  type ConversationVisibility,
} from '@archon/core/db/conversation-visibility';
import * as userDb from '@archon/core/db/users';
import * as workflowDb from '@archon/core/db/workflows';
import { getAuth, isWebAuthEnabled, isConversationOwnershipEnforced } from '../auth';
// Imported from the pure config module rather than the barrel: route tests mock
// '../auth', and the header name must stay the real implementation under them.
import { webAuthHeaderName } from '../auth/config';
import { apiError, getLog } from './api-route-kit';

interface WebUserContext {
  userId: User['id'];
  role: User['role'];
}

/**
 * Trusted proxy headers require a proxy that strips client-supplied values, or
 * a loopback-only server. Missing identity leaves solo requests unattributed;
 * the API gate maps it to 401 when authentication is required.
 */
export async function resolveAuthContext(c: Context): Promise<WebUserContext | undefined> {
  const auth = getAuth();
  if (auth) {
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session?.user) {
        const user = await userDb.findOrCreateUserByPlatformIdentity(
          'web',
          session.user.id,
          session.user.name ?? session.user.email ?? undefined
        );
        return { userId: user.id, role: user.role };
      }
    } catch (err) {
      // Proxy-authenticated installs can keep attributing requests during a
      // session-backend outage. Without a header the API gate fails closed.
      getLog().warn({ err: err as Error, path: c.req.path }, 'web.session_resolve_failed');
    }
  }

  const headerName = webAuthHeaderName();
  const headerVal = c.req.header(headerName)?.trim();
  if (!headerVal) return undefined;
  try {
    const user = await userDb.findOrCreateUserByPlatformIdentity('web', headerVal, headerVal);
    return { userId: user.id, role: user.role };
  } catch (err) {
    // Attribution is best-effort; the strict credential guard reports 503.
    getLog().warn(
      { err: err as Error, headerPresent: true, path: c.req.path },
      'web.user_resolve_failed'
    );
    return undefined;
  }
}

export async function resolveRunActor(c: Context): Promise<RunActor> {
  const identity = await resolveAuthContext(c);
  if (identity) return { kind: 'user', userId: identity.userId };
  const headerName = webAuthHeaderName();
  const suppliedIdentity = Boolean(c.req.header(headerName)?.trim());
  return { kind: isWebAuthEnabled() || suppliedIdentity ? 'unidentified' : 'operator' };
}

export async function resolveWebUserId(c: Context): Promise<string | undefined> {
  return (await resolveAuthContext(c))?.userId;
}

/**
 * Credential endpoints must distinguish missing identity (401) from a backend
 * outage (503). Unlike soft attribution, a session outage cannot use a header
 * fallback here.
 */
export async function requireWebUser(
  c: Context,
  failMessage = 'Web authentication required'
): Promise<WebUserContext | { error: Response }> {
  const auth = getAuth();
  if (auth) {
    let session: Awaited<ReturnType<typeof auth.api.getSession>> | undefined;
    try {
      session = await auth.api.getSession({ headers: c.req.raw.headers });
    } catch (err) {
      getLog().error({ err: err as Error }, 'web.session_resolve_failed');
      return { error: apiError(c, 503, 'Could not verify session — backend unavailable') };
    }
    if (session?.user) {
      try {
        const user = await userDb.findOrCreateUserByPlatformIdentity(
          'web',
          session.user.id,
          session.user.name ?? session.user.email ?? undefined
        );
        return { userId: user.id, role: user.role };
      } catch (err) {
        getLog().error({ err: err as Error }, 'web.user_resolve_failed');
        return { error: apiError(c, 503, 'Could not verify web identity — backend unavailable') };
      }
    }
  }

  const headerName = webAuthHeaderName();
  const headerVal = c.req.header(headerName)?.trim();
  if (!headerVal) return { error: apiError(c, 401, failMessage) };
  try {
    const user = await userDb.findOrCreateUserByPlatformIdentity('web', headerVal, headerVal);
    return { userId: user.id, role: user.role };
  } catch (err) {
    getLog().error({ err: err as Error, headerPresent: true }, 'web.user_resolve_failed');
    return { error: apiError(c, 503, 'Could not verify web identity — backend unavailable') };
  }
}

/**
 * Which conversations this request may reach. Under ownership enforcement the
 * caller resolves on the strict path, so neither a missing identity (401) nor an
 * identity-backend outage (503) can fall back to the whole install.
 */
export async function requireConversationVisibility(
  c: Context
): Promise<ConversationVisibility | { error: Response }> {
  if (!isConversationOwnershipEnforced()) return { kind: 'all' };
  const web = await requireWebUser(c, 'Authentication required');
  if ('error' in web) return web;
  return { kind: 'owner', userId: web.userId };
}

/**
 * Bare platform IDs must resolve uniquely across platforms. Dispatch always uses
 * the web adapter's row. SSE prefers web chats but also carries run transcripts
 * from other platforms, so an unambiguous non-web row can be the fallback.
 */
type ConversationKey =
  | { platformId: string }
  | { webPlatformId: string }
  | { webFirstPlatformId: string }
  | { id: string };

async function loadConversation(key: ConversationKey): Promise<Conversation | null> {
  if ('platformId' in key) return conversationDb.findConversationByPlatformId(key.platformId);
  if ('webPlatformId' in key) {
    return conversationDb.getConversationByPlatformId('web', key.webPlatformId);
  }
  if ('webFirstPlatformId' in key) {
    return (
      (await conversationDb.getConversationByPlatformId('web', key.webFirstPlatformId)) ??
      (await conversationDb.findConversationByPlatformId(key.webFirstPlatformId))
    );
  }
  return conversationDb.getConversationById(key.id);
}

/**
 * The authorization every route naming a conversation goes through. Identity is
 * resolved before the row is loaded, so a refused caller learns nothing about
 * which ids exist, and a non-owner gets the same 404 as a missing row because
 * web conversation ids are guessable. A run's own transcript stays readable to
 * any signed-in user, as the run itself is; writing to it stays the owner's.
 *
 * Throws when the conversation lookup fails; callers map that to their 500.
 */
export async function authorizeConversation(
  c: Context,
  key: ConversationKey,
  access: 'read' | 'write'
): Promise<
  { conversation: Conversation; visibility: ConversationVisibility } | { error: Response }
> {
  const visibility = await requireConversationVisibility(c);
  if ('error' in visibility) return visibility;
  const conversation = await loadConversation(key);
  if (!conversation) return { error: apiError(c, 404, 'Conversation not found') };
  if (isConversationVisible(conversation, visibility)) return { conversation, visibility };
  if (access === 'read' && (await workflowDb.isRunTranscriptConversation(conversation.id))) {
    return { conversation, visibility };
  }
  getLog().warn(
    {
      conversationId: conversation.id,
      platformType: conversation.platform_type,
      access,
      ownerPresent: conversation.user_id !== null,
    },
    'api.conversation_access_denied'
  );
  return { error: apiError(c, 404, 'Conversation not found') };
}

/**
 * Dispatch uses the web adapter's identity and the same caller that authorized
 * the row. Solo installs may dispatch to an absent row, but never through a
 * failed lookup.
 */
export async function authorizeDispatchConversation(
  c: Context,
  platformId: string
): Promise<{ conversation: Conversation | null; actor: RunActor } | { error: Response }> {
  try {
    if (isConversationOwnershipEnforced()) {
      const access = await authorizeConversation(c, { webPlatformId: platformId }, 'write');
      if ('error' in access) return access;
      const actor: RunActor =
        access.visibility.kind === 'owner'
          ? { kind: 'user', userId: access.visibility.userId }
          : await resolveRunActor(c);
      return { conversation: access.conversation, actor };
    }
    const conversation = await conversationDb.getConversationByPlatformId('web', platformId);
    return { conversation, actor: await resolveRunActor(c) };
  } catch (err: unknown) {
    getLog().error({ err, conversationId: platformId }, 'conversation_lookup_failed');
    return { error: apiError(c, 500, 'Failed to load conversation') };
  }
}
