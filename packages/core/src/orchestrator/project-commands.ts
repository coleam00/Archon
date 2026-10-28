/**
 * Chat project commands: /register-project, /update-project, /remove-project,
 * /setproject and /detach-project. Register and update are the chat writers of
 * `default_cwd`.
 */
import { existsSync } from 'fs';
import { isAbsolute } from 'node:path';
import { canonicalizeProjectPath } from '@archon/paths';
import type { IPlatformAdapter, Conversation, Codebase } from '../types';
import * as db from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import * as sessionDb from '../db/sessions';
import * as commandHandler from '../handlers/command-handler';
import { ActiveContainerEnvironmentsError } from '../db/codebase-delete-error';
import {
  registerRepository,
  registerFolder,
  ProjectRegistrationError,
} from '../handlers/sql-registration';
import { detectProjectKind, ProjectKindDetectionError } from '../services/project-kind';
import { toError } from '../utils/error';
import { safeDeactivateSession } from '../state/session-transitions';
import type { ProjectRegistration } from './chat-tools';
import { getLog } from './agent-log';
import { parseSlashCommand } from '../utils/command-args';

function parseProjectRegistration(message: string): ProjectRegistration | null {
  const { command, args } = parseSlashCommand(message);
  if (command !== 'register-project') return null;
  const folder = args[0] === '--folder';
  const [projectName, ...pathParts] = folder ? args.slice(1) : args;
  if (!projectName || pathParts.length === 0) return null;
  return {
    projectName,
    projectPath: pathParts.join(' '),
    ...(folder ? { folder: true } : {}),
  };
}

/**
 * Resolve a codebase by name using 4-tier fuzzy matching.
 * Tiers: exact → case-insensitive → prefix → substring.
 * Returns undefined if not found; throws on ambiguity within a tier.
 *
 * Mirrors `resolveWorkflowName` (packages/workflows/src/router.ts) but uses
 * prefix instead of suffix for tier 3 — project names don't follow the
 * `archon-X` suffix convention workflows use.
 */
function resolveCodebaseName(name: string, codebases: readonly Codebase[]): Codebase | undefined {
  const exact = codebases.find(c => c.name === name);
  if (exact) return exact;

  const lowerName = name.toLowerCase();

  function checkTier(matches: readonly Codebase[], logEvent: string): Codebase | undefined {
    if (matches.length === 1) {
      getLog().debug({ requested: name, matched: matches[0].name }, logEvent);
      return matches[0];
    }
    if (matches.length > 1) {
      const candidates = matches.map(c => `  - ${c.name}`).join('\n');
      throw new Error(`Ambiguous project name '${name}'. Did you mean:\n${candidates}`);
    }
    return undefined;
  }

  return (
    checkTier(
      codebases.filter(c => c.name.toLowerCase() === lowerName),
      'project.set_resolve_case_insensitive_match'
    ) ??
    checkTier(
      codebases.filter(c => c.name.toLowerCase().startsWith(lowerName)),
      'project.set_resolve_prefix_match'
    ) ??
    checkTier(
      codebases.filter(c => c.name.toLowerCase().includes(lowerName)),
      'project.set_resolve_substring_match'
    )
  );
}

export async function handleRegisterProject(message: string): Promise<string> {
  const registration = parseProjectRegistration(message);
  if (!registration) return 'Usage: /register-project [--folder] <name> <path>';
  try {
    return await registerProject(registration);
  } catch (error) {
    if (error instanceof ProjectKindDetectionError) return error.message;
    return `Could not register ${registration.folder ? 'folder project' : 'project'}: ${toError(error).message}`;
  }
}

export async function registerProject({
  projectName,
  projectPath,
  folder,
}: ProjectRegistration): Promise<string> {
  // Canonicalize through the one shared `default_cwd` canonicalizer, the same
  // one `registerFolder`, the CLI gate and `archon doctor` use. Calling a
  // different realpath variant here is what made a chat-registered project and a
  // CLI-registered project disagree on Windows and register two rows (#2927).
  // It runs BEFORE the existence check so the path being validated is the path
  // being stored — and because chat input gets no shell expansion, so `~/work`
  // arrives literally and only this call can resolve it.
  const canonicalPath = await canonicalizeProjectPath(projectPath);

  if (!existsSync(canonicalPath)) {
    return `Path does not exist: ${canonicalPath}`;
  }

  // Check if codebase already exists with this name
  const existing = await codebaseDb.listCodebaseRegistrations();
  const alreadyExists = existing.find(c => c.name.toLowerCase() === projectName.toLowerCase());

  const kind = folder ? 'folder' : await detectProjectKind(canonicalPath);
  if (alreadyExists && !isAbsolute(alreadyExists.stored_default_cwd)) {
    await codebaseDb.repairCodebaseRegistration(alreadyExists.id, {
      default_cwd: canonicalPath,
      kind,
    });
    return `Project "${projectName}" re-registered successfully!\nPath: ${canonicalPath}\nID: ${alreadyExists.id}`;
  }

  try {
    const result =
      kind === 'folder'
        ? await registerFolder(canonicalPath, projectName)
        : await registerRepository(canonicalPath, { name: projectName });
    const kindNote = kind === 'folder' ? '\nKind: folder project (runs in place)' : '';
    return `Project "${result.name}" ${result.alreadyExisted ? 'is already registered' : 'registered successfully!'}\nPath: ${result.defaultCwd}\nID: ${result.codebaseId}${kindNote}`;
  } catch (error) {
    if (error instanceof ProjectRegistrationError)
      return `Could not register ${kind === 'folder' ? 'folder project' : 'project'}: ${error.message}`;
    throw error;
  }
}

/**
 * Handle /update-project command.
 * Updates the path for an existing registered project.
 */
export async function handleUpdateProject(message: string): Promise<string> {
  const { args } = commandHandler.parseCommand(message);
  if (args.length < 2) {
    return 'Usage: /update-project <name> <new-path>';
  }

  const [projectName, ...pathParts] = args;
  const suppliedPath = pathParts.join(' ');

  // A repointed project has to land on the same canonical form the lookups ask
  // for, exactly like a freshly registered one — storing the raw argument here
  // wrote a `default_cwd` no reader could match (#2927). Canonicalize before
  // validating, so the path checked is the path stored and a chat-supplied
  // `~/work` resolves (chat input gets no shell expansion).
  const newPath = await canonicalizeProjectPath(suppliedPath);

  if (!existsSync(newPath)) {
    return `Path does not exist: ${newPath}`;
  }

  // Find existing codebase by name
  const existing = await codebaseDb.listCodebaseRegistrations();
  const codebase = existing.find(c => c.name.toLowerCase() === projectName.toLowerCase());

  if (!codebase) {
    return `Project "${projectName}" not found. Use /register-project to create it.`;
  }

  try {
    await codebaseDb.updateCodebase(codebase, { default_cwd: newPath });
  } catch (err) {
    getLog().warn({ err: err as Error, codebaseId: codebase.id, newPath }, 'project.update_failed');
    // Row gone (deleted between the fetch above and the UPDATE) is the only
    // case where "removed" is the honest answer; anything else is an
    // operational DB failure and should say so instead of blaming data state.
    if (err instanceof codebaseDb.CodebaseNotFoundError) {
      return `Project "${projectName}" could not be updated — it appears to have been removed. Use /register-project to re-create it.`;
    }
    return `Project "${projectName}" could not be updated — database error. Please try again.`;
  }
  getLog().info(
    { name: projectName, oldPath: codebase.stored_default_cwd, newPath, id: codebase.id },
    'project.update_completed'
  );
  return `Project "${projectName}" updated.\nOld path: ${codebase.stored_default_cwd}\nNew path: ${newPath}`;
}

/**
 * Handle /remove-project command.
 * Deletes a registered project from the database.
 */
export async function handleRemoveProject(message: string): Promise<string> {
  const { args } = commandHandler.parseCommand(message);
  if (args.length < 1) {
    return 'Usage: /remove-project <name>';
  }

  const projectName = args[0];

  // Find existing codebase by name
  const existing = await codebaseDb.listCodebaseRegistrations();
  const codebase = existing.find(c => c.name.toLowerCase() === projectName.toLowerCase());

  if (!codebase) {
    return `Project "${projectName}" not found.`;
  }

  try {
    await codebaseDb.deleteCodebase(codebase.id);
  } catch (error) {
    if (error instanceof ActiveContainerEnvironmentsError) return error.message;
    throw error;
  }
  getLog().info({ name: projectName, id: codebase.id }, 'project.remove_completed');
  return `Project "${projectName}" removed.\nPath was: ${codebase.stored_default_cwd}`;
}

/**
 * Handle /setproject command. Four effects:
 * 1. Binds the conversation to the resolved codebase (writes `codebase_id`).
 * 2. Clears `cwd` — the project root remains codebase.default_cwd;
 *    conversation.cwd is only an explicit runtime override.
 * 3. Clears `isolation_env_id` — the old project's worktree no longer applies.
 * 4. Deactivates the active AI session ('project-changed'), so the next
 *    message starts fresh in the new project's context.
 * Uses 4-tier fuzzy name resolution (exact → case-insensitive → prefix →
 * substring) via resolveCodebaseName. Updates by the DB primary key
 * (conversation.id), never the platform conversation id.
 */
export async function handleSetProject(
  message: string,
  conversation: Conversation
): Promise<string> {
  const { args } = commandHandler.parseCommand(message);
  if (args.length < 1) {
    return 'Usage: /setproject <project-name>';
  }

  const projectName = args.join(' ');
  const codebases = await codebaseDb.listCodebases();

  let codebase: Codebase | undefined;
  try {
    codebase = resolveCodebaseName(projectName, codebases);
  } catch (err) {
    return (err as Error).message;
  }

  if (!codebase) {
    const available = codebases.map(c => c.name).join(', ');
    return available
      ? `Project "${projectName}" not found.\nRegistered projects: ${available}`
      : `Project "${projectName}" not found. No projects registered — use /register-project.`;
  }

  // Deactivate the old session BEFORE rebinding the conversation: if either
  // session step throws, the switch aborts with the conversation untouched
  // (next message just starts a fresh session in the OLD project). The reverse
  // order would leave a rebound conversation with the old project's session
  // still active — resuming old-project context under the new project's cwd.
  const session = await sessionDb.getActiveSession(conversation.id);
  if (session) {
    await safeDeactivateSession(session.id, 'setproject');
  }

  // Intentionally non-destructive: clearing isolation_env_id detaches the
  // conversation from its worktree WITHOUT destroying it — the worktree may
  // hold uncommitted work and the user may switch back (project-switch is not
  // terminal, unlike conversation-closed). The env row stays active until
  // /worktree remove or the periodic isolation cleanup reaps it; we surface
  // that to the user below instead of tearing it down.
  const detachedWorktree = conversation.isolation_env_id !== null;
  await db.updateConversation(conversation.id, {
    codebase_id: codebase.id,
    cwd: null,
    isolation_env_id: null,
  });
  if (detachedWorktree) {
    getLog().info(
      { conversationId: conversation.id, isolationEnvId: conversation.isolation_env_id },
      'project.set_worktree_detached'
    );
  }

  getLog().info(
    { conversationId: conversation.id, projectName: codebase.name, codebaseId: codebase.id },
    'project.set_completed'
  );
  let reply = `Project set to **${codebase.name}**\nWorking directory: ${codebase.default_cwd}`;
  if (detachedWorktree) {
    // Don't suggest `/worktree remove` here: it reads isolation_env_id from
    // THIS conversation, which we just cleared — it would short-circuit with
    // "not using a worktree". Cleanup tools that operate on the environments
    // table directly are the working remedies.
    reply +=
      '\n\nNote: the previous worktree was detached but left in place — clean it up with `archon isolation cleanup` or from the project’s Environments list in the web UI.';
  }
  return reply;
}

export async function handleDetachProject(
  platform: IPlatformAdapter,
  platformId: string,
  args: string[],
  parentPlatformId?: string
): Promise<string> {
  if (args.length !== 1 || !args[0].trim()) {
    return 'Usage: /detach-project "<current-project-name>". Supply the exact project name; quote names containing spaces.';
  }
  if (!platform.capabilities.canDetachProject) {
    return 'Project detachment is not supported on this conversation surface.';
  }
  const conversation = await db.getConversationByPlatformId(platform.getPlatformType(), platformId);
  if (!conversation) return 'Cannot detach: this conversation does not exist.';
  const result = await db.detachConversationProject({
    conversationId: conversation.id,
    projectName: args[0],
    platformType: platform.getPlatformType(),
    parentPlatformId,
  });
  switch (result.status) {
    case 'detached':
      return `This conversation is now neutral. Project "${result.projectName}" remains registered and available to other conversations.`;
    case 'blocked': {
      const blockers = result.runs.map(run => `- Run ${run.id}: ${run.status}`);
      if (result.environmentId !== null)
        blockers.push(`- Attached environment: ${result.environmentId}`);
      return `Cannot detach while this conversation owns work or an environment:\n${blockers.join('\n')}\nResolve runs through manage_run, CLI or Web run controls, and clean the environment through the existing isolation controls before retrying. Nothing was cancelled or removed.`;
    }
    case 'refused':
      switch (result.reason) {
        case 'parent-bound':
          return 'Cannot detach this child conversation: it would inherit its bound parent project on the next message.';
        case 'parent-changed':
          return 'Cannot detach: the parent conversation changed during validation. Retry the command.';
        case 'neutral':
          return 'This conversation is already neutral.';
        case 'name':
          return 'Cannot detach: supply the exact, unambiguous name of the project currently bound to this conversation.';
      }
  }
}
