/**
 * GitLab platform adapter using REST API v4 and Webhooks
 * Handles issue and MR comments with @mention detection
 *
 * Community forge adapter — see packages/adapters/src/community/forge/README.md
 */
import { readdir, access } from 'fs/promises';
import { join } from 'path';
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import type { IsolationHints } from '@archon/isolation';
import {
  ConversationNotFoundError,
  handleMessage,
  classifyAndFormatError,
  toError,
  onConversationClosed,
  ConversationLockManager,
} from '@archon/core';
import { getArchonWorkspacesPath, getCommandFolderSearchPaths, createLogger } from '@archon/paths';
import {
  syncRepository,
  addSafeDirectory,
  toRepoPath,
  toBranchName,
  isWorktreePath,
  execFileAsync,
} from '@archon/git';
import * as db from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import { parseAllowedUsers, isGitLabUserAuthorized, verifyWebhookToken } from './auth';
import { splitIntoParagraphChunks } from '../../../utils/message-splitting';
import type { GitLabWebhookEvent, GitLabIssue, GitLabMergeRequest } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.gitlab');
  return cachedLog;
}

const MAX_LENGTH = 65000; // Practical limit for GitLab notes

/** Hidden marker added to bot comments to prevent self-triggering loops */
const BOT_RESPONSE_MARKER = '<!-- archon-bot-response -->';

export class GitLabAdapter implements IPlatformAdapter {
  private readonly gitlabUrl: string;
  private readonly token: string;
  private readonly webhookSecret: string;
  private readonly allowedUsers: string[];
  private readonly botMention: string;
  private readonly lockManager: ConversationLockManager;

  constructor(
    token: string,
    webhookSecret: string,
    lockManager: ConversationLockManager,
    gitlabUrl?: string,
    botMention?: string
  ) {
    if (!token) {
      throw new Error('GitLabAdapter requires a non-empty token');
    }
    if (!webhookSecret) {
      throw new Error('GitLabAdapter requires a non-empty webhookSecret');
    }

    this.gitlabUrl = (gitlabUrl ?? 'https://gitlab.com').replace(/\/+$/, '');
    this.token = token;
    this.webhookSecret = webhookSecret;
    this.lockManager = lockManager;
    this.botMention = botMention ?? 'Archon';

    this.allowedUsers = parseAllowedUsers(process.env.GITLAB_ALLOWED_USERS);
    if (this.allowedUsers.length > 0) {
      getLog().info({ userCount: this.allowedUsers.length }, 'gitlab.whitelist_enabled');
    } else {
      getLog().info('gitlab.whitelist_disabled');
    }

    getLog().info(
      { botMention: this.botMention, gitlabUrl: this.gitlabUrl },
      'gitlab.adapter_initialized'
    );
  }

  // ---------------------------------------------------------------------------
  // IPlatformAdapter methods
  // ---------------------------------------------------------------------------

  async sendMessage(
    conversationId: string,
    message: string,
    _metadata?: MessageMetadata
  ): Promise<void> {
    const parsed = this.parseConversationId(conversationId);
    if (!parsed) {
      getLog().error({ conversationId }, 'gitlab.invalid_conversation_id');
      return;
    }

    getLog().debug({ conversationId, messageLength: message.length }, 'gitlab.send_message');

    if (message.length <= MAX_LENGTH) {
      await this.postComment(parsed, message);
    } else {
      getLog().debug({ messageLength: message.length }, 'gitlab.message_splitting');
      const chunks = splitIntoParagraphChunks(message, MAX_LENGTH - 500);

      for (let i = 0; i < chunks.length; i++) {
        try {
          await this.postComment(parsed, chunks[i]);
        } catch (error) {
          const err = error as Error;
          getLog().error(
            { err, chunkIndex: i + 1, totalChunks: chunks.length, conversationId },
            'gitlab.chunk_post_failed'
          );
          const partialError = new Error(
            `Failed to post comment chunk ${String(i + 1)}/${String(chunks.length)}. ` +
              `${String(i)} chunk(s) were posted before failure.`
          );
          partialError.cause = error;
          throw partialError;
        }
      }
    }
  }

  getStreamingMode(): 'batch' {
    return 'batch';
  }

  getPlatformType(): string {
    return 'gitlab';
  }

  async start(): Promise<void> {
    getLog().info('gitlab.webhook_adapter_ready');
  }

  stop(): void {
    getLog().info('gitlab.adapter_stopped');
  }

  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    return originalConversationId;
  }

  // ---------------------------------------------------------------------------
  // GitLab REST API helper
  // ---------------------------------------------------------------------------

  private async gitlabApi<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.gitlabUrl}/api/v4${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `GitLab API ${method} ${path}: ${String(response.status)} ${response.statusText} - ${text}`
      );
    }
    return response.json() as Promise<T>;
  }

  // ---------------------------------------------------------------------------
  // Comment posting with retry
  // ---------------------------------------------------------------------------

  private isRetryableError(error: unknown): boolean {
    const err = error as Error | undefined;
    const message = err?.message ?? '';
    const causeErr = (error as { cause?: Error }).cause;
    const cause = causeErr?.message ?? '';
    const combined = `${message} ${cause}`.toLowerCase();

    return (
      combined.includes('timeout') ||
      combined.includes('econnrefused') ||
      combined.includes('econnreset') ||
      combined.includes('etimedout') ||
      combined.includes('fetch failed') ||
      combined.includes('429') ||
      combined.includes('502') ||
      combined.includes('503') ||
      combined.includes('504')
    );
  }

  private async postComment(
    parsed: { projectPath: string; iid: number; isMR: boolean },
    message: string
  ): Promise<void> {
    const markedMessage = `${message}\n\n${BOT_RESPONSE_MARKER}`;
    const maxRetries = 3;
    const conversationId = this.buildConversationId(parsed.projectPath, parsed.iid, parsed.isMR);
    const encodedProject = encodeURIComponent(parsed.projectPath);

    const notesPath = parsed.isMR
      ? `/projects/${encodedProject}/merge_requests/${String(parsed.iid)}/notes`
      : `/projects/${encodedProject}/issues/${String(parsed.iid)}/notes`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.gitlabApi('POST', notesPath, { body: markedMessage });
        getLog().debug({ conversationId }, 'gitlab.comment_posted');
        return;
      } catch (error) {
        const isRetryable = this.isRetryableError(error);
        if (attempt < maxRetries && isRetryable) {
          const delay = 1000 * attempt;
          getLog().warn(
            { attempt, maxRetries, conversationId, delayMs: delay },
            'gitlab.comment_post_retry'
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        getLog().error(
          {
            err: error,
            conversationId,
            attempt,
            maxRetries,
            wasRetryable: isRetryable,
            messageLength: message.length,
          },
          'gitlab.comment_post_failed'
        );
        throw error;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Conversation ID: group/project#123 (issues), group/project!456 (MRs)
  // ---------------------------------------------------------------------------

  private buildConversationId(projectPath: string, iid: number, isMR: boolean): string {
    const separator = isMR ? '!' : '#';
    return `${projectPath}${separator}${String(iid)}`;
  }

  private parseConversationId(
    conversationId: string
  ): { projectPath: string; iid: number; isMR: boolean } | null {
    const match = /^(.+?)([#!])(\d+)$/.exec(conversationId);
    if (!match) return null;
    return {
      projectPath: match[1],
      iid: parseInt(match[3], 10),
      isMR: match[2] === '!',
    };
  }

  // ---------------------------------------------------------------------------
  // @mention detection
  // ---------------------------------------------------------------------------

  private hasMention(text: string): boolean {
    const pattern = new RegExp(`@${this.botMention}(?:[\\s,:;]|$)`, 'i');
    return pattern.test(text);
  }

  private stripMention(text: string): string {
    // `+` consumes all trailing separators (e.g. "@archon, " not just "@archon")
    const pattern = new RegExp(`@${this.botMention}(?:[\\s,:;]+|$)`, 'gi');
    return text.replace(pattern, '').trim();
  }

  // ---------------------------------------------------------------------------
  // Event parsing
  // ---------------------------------------------------------------------------

  private parseEvent(event: GitLabWebhookEvent): {
    projectPath: string;
    iid: number;
    comment: string;
    eventType: 'note' | 'issue' | 'merge_request';
    isMR: boolean;
    issue?: GitLabIssue;
    mergeRequest?: GitLabMergeRequest;
    isCloseEvent?: boolean;
    isMerged?: boolean;
  } | null {
    const projectPath = event.project.path_with_namespace;

    // Issue closed
    if (event.object_kind === 'issue' && event.object_attributes.action === 'close') {
      return {
        projectPath,
        iid: event.object_attributes.iid,
        comment: '',
        eventType: 'issue',
        isMR: false,
        isCloseEvent: true,
      };
    }

    // MR closed or merged
    if (event.object_kind === 'merge_request') {
      const action = event.object_attributes.action;
      if (action === 'close' || action === 'merge') {
        return {
          projectPath,
          iid: event.object_attributes.iid,
          comment: '',
          eventType: 'merge_request',
          isMR: true,
          isCloseEvent: true,
          isMerged: action === 'merge',
        };
      }
    }

    // Note (comment) on issue or MR
    if (event.object_kind === 'note') {
      const noteType = event.object_attributes.noteable_type;
      const isMR = noteType === 'MergeRequest';
      const iid = isMR ? event.merge_request?.iid : event.issue?.iid;

      if (!iid) return null;

      return {
        projectPath,
        iid,
        comment: event.object_attributes.note,
        eventType: 'note',
        isMR,
        issue: event.issue,
        mergeRequest: event.merge_request,
      };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Comment history
  // ---------------------------------------------------------------------------

  private async fetchCommentHistory(
    projectPath: string,
    iid: number,
    isMR: boolean
  ): Promise<string[]> {
    try {
      const encodedProject = encodeURIComponent(projectPath);
      const notesPath = isMR
        ? `/projects/${encodedProject}/merge_requests/${String(iid)}/notes?per_page=20&sort=asc`
        : `/projects/${encodedProject}/issues/${String(iid)}/notes?per_page=20&sort=asc`;

      const notes = await this.gitlabApi<
        { author?: { username?: string } | null; body?: string | null }[]
      >('GET', notesPath);

      return notes.slice(-20).map(note => {
        const author = note.author?.username ?? 'unknown';
        const body = note.body ?? '';
        return `${author}: ${body}`;
      });
    } catch (error) {
      getLog().error({ err: error, projectPath, iid, isMR }, 'gitlab.comment_history_fetch_failed');
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Context builders
  // ---------------------------------------------------------------------------

  private buildIssueContext(issue: GitLabIssue, userComment: string): string {
    const labels = issue.labels.map(l => l.title).join(', ');
    return `[GitLab Issue Context]
Issue #${String(issue.iid)}: "${issue.title}"
Labels: ${labels}
Status: ${issue.state}

Description:
${issue.description ?? ''}

---

${userComment}

Use 'glab issue view ${String(issue.iid)}' for full details if needed.`;
  }

  private buildMRContext(mr: GitLabMergeRequest, userComment: string): string {
    return `[GitLab Merge Request Context]
MR !${String(mr.iid)}: "${mr.title}"
Status: ${mr.state}
Source: ${mr.source_branch} → ${mr.target_branch}

Description:
${mr.description ?? ''}

---

${userComment}

Use 'glab mr view ${String(mr.iid)}' for full details and 'glab mr diff ${String(mr.iid)}' for the diff.`;
  }

  // ---------------------------------------------------------------------------
  // Repository management
  // ---------------------------------------------------------------------------

  private async ensureRepoReady(
    projectPath: string,
    defaultBranch: string,
    repoPath: string,
    shouldSync: boolean
  ): Promise<void> {
    let directoryExists = false;
    try {
      await access(repoPath);
      directoryExists = true;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        getLog().error({ repoPath, errorCode: err.code, err }, 'gitlab.repo_path_access_failed');
        throw new Error(
          `Cannot access repository at ${repoPath}: ${err.code ?? err.message}. ` +
            'Check permissions and disk health.'
        );
      }
    }

    if (directoryExists) {
      if (shouldSync) {
        getLog().info({ repoPath, defaultBranch }, 'gitlab.repo_syncing');
        const syncResult = await syncRepository(toRepoPath(repoPath), toBranchName(defaultBranch));
        if (!syncResult.ok) {
          getLog().error(
            { error: syncResult.error, repoPath, defaultBranch },
            'gitlab.repo_sync_failed'
          );
          throw new Error(
            `Failed to sync repository to ${defaultBranch}. ` +
              'Try /reset or check if the branch exists.'
          );
        }
      }
      return;
    }

    // Clone the repository
    // GitLab self-hosted instances need oauth2:token auth and credential helper disabled
    // to prevent macOS Keychain from intercepting and blocking the clone
    getLog().info({ projectPath, repoPath }, 'gitlab.repo_cloning');

    const urlObj = new URL(this.gitlabUrl);
    const repoUrl = `${urlObj.protocol}//oauth2:${this.token}@${urlObj.host}/${projectPath}.git`;

    try {
      await execFileAsync('git', ['-c', 'credential.helper=', 'clone', repoUrl, repoPath], {
        timeout: 120000,
      });
    } catch (error) {
      const err = error as Error;
      // Sanitize token from all error properties (message, stack, cause)
      const sanitize = (s: string): string => s.replaceAll(this.token, '***');
      const sanitized = sanitize(err.message);
      const msg = sanitized.toLowerCase();

      const sanitizedError: Record<string, unknown> = { message: sanitized };
      if (err.stack) sanitizedError.stack = sanitize(err.stack);
      if (err.cause && typeof (err.cause as Error).message === 'string') {
        sanitizedError.cause = sanitize((err.cause as Error).message);
      }
      const errRecord = err as unknown as Record<string, unknown>;
      if (typeof errRecord.stdout === 'string') sanitizedError.stdout = sanitize(errRecord.stdout);
      if (typeof errRecord.stderr === 'string') sanitizedError.stderr = sanitize(errRecord.stderr);

      getLog().error({ projectPath, repoPath, error: sanitizedError }, 'gitlab.repo_clone_failed');

      if (msg.includes('not found') || msg.includes('404')) {
        throw new Error(
          `Repository ${projectPath} not found or is private. Check repository access.`
        );
      }
      if (
        msg.includes('authentication failed') ||
        msg.includes('could not read') ||
        msg.includes('403')
      ) {
        throw new Error(
          `Authentication failed for ${projectPath}. Check GITLAB_TOKEN permissions.`
        );
      }
      throw new Error(`Failed to clone ${projectPath}: ${sanitized}`);
    }

    await addSafeDirectory(toRepoPath(repoPath));
  }

  private async autoDetectAndLoadCommands(repoPath: string, codebaseId: string): Promise<void> {
    const commandFolders = getCommandFolderSearchPaths();

    for (const folder of commandFolders) {
      try {
        const fullPath = join(repoPath, folder);
        await access(fullPath);

        const files = (await readdir(fullPath)).filter(f => f.endsWith('.md'));
        if (files.length === 0) continue;

        const commands = await codebaseDb.getCodebaseCommands(codebaseId);
        files.forEach(file => {
          commands[file.replace('.md', '')] = {
            path: join(folder, file),
            description: `From ${folder}`,
          };
        });

        await codebaseDb.updateCodebaseCommands(codebaseId, commands);
        getLog().info({ commandCount: files.length, folder }, 'gitlab.commands_loaded');
        return;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          continue;
        }
        getLog().error({ err, folder, errorCode: err.code }, 'gitlab.commands_load_error');
        continue;
      }
    }
  }

  private async getOrCreateCodebaseForRepo(projectPath: string): Promise<{
    codebase: { id: string; name: string; default_cwd: string };
    repoPath: string;
    isNew: boolean;
  }> {
    const repoUrlNoGit = `${this.gitlabUrl}/${projectPath}`;
    const repoUrlWithGit = `${repoUrlNoGit}.git`;

    let existing = await codebaseDb.findCodebaseByRepoUrl(repoUrlNoGit);
    existing ??= await codebaseDb.findCodebaseByRepoUrl(repoUrlWithGit);

    const canonicalPath = join(getArchonWorkspacesPath(), ...projectPath.split('/'));

    if (existing) {
      const looksLikeWorktreePath = existing.default_cwd.includes('/worktrees/');
      if (looksLikeWorktreePath || (await isWorktreePath(existing.default_cwd))) {
        getLog().info(
          { codebaseName: existing.name, canonicalPath },
          'gitlab.stale_worktree_path_fixed'
        );
        await codebaseDb.updateCodebase(existing.id, { default_cwd: canonicalPath });
        existing.default_cwd = canonicalPath;
      }

      getLog().info(
        { codebaseName: existing.name, path: existing.default_cwd },
        'gitlab.existing_codebase_found'
      );
      return { codebase: existing, repoPath: existing.default_cwd, isNew: false };
    }

    const codebase = await codebaseDb.createCodebase({
      name: projectPath,
      repository_url: repoUrlNoGit,
      default_cwd: canonicalPath,
    });

    getLog().info({ codebaseName: codebase.name, path: canonicalPath }, 'gitlab.codebase_created');
    return { codebase, repoPath: canonicalPath, isNew: true };
  }

  private async cleanupWorktree(
    projectPath: string,
    iid: number,
    isMR: boolean,
    merged = false
  ): Promise<void> {
    const conversationId = this.buildConversationId(projectPath, iid, isMR);
    getLog().info({ conversationId, merged }, 'gitlab.isolation_cleanup_started');

    try {
      await onConversationClosed('gitlab', conversationId, { merged });
      getLog().info({ conversationId }, 'gitlab.isolation_cleanup_completed');
    } catch (error) {
      const err = error as Error;
      getLog().error({ err, conversationId }, 'gitlab.isolation_cleanup_failed');
    }
  }

  // ---------------------------------------------------------------------------
  // Webhook handler
  // ---------------------------------------------------------------------------

  async handleWebhook(payload: string, token: string): Promise<void> {
    // 1. Verify token
    if (!verifyWebhookToken(token, this.webhookSecret)) {
      getLog().error(
        { tokenPrefix: token?.substring(0, 8) + '...', payloadSize: payload.length },
        'gitlab.invalid_webhook_token'
      );
      return;
    }

    // 2. Parse event
    let event: GitLabWebhookEvent;
    try {
      event = JSON.parse(payload) as GitLabWebhookEvent;
    } catch (error) {
      getLog().error({ err: error, payloadSize: payload.length }, 'gitlab.webhook_parse_failed');
      return;
    }

    // 3. Authorization check
    const senderUsername = event.user?.username;
    if (!isGitLabUserAuthorized(senderUsername, this.allowedUsers)) {
      const maskedUser = senderUsername ? `${senderUsername.slice(0, 3)}***` : 'unknown';
      getLog().info({ maskedUser }, 'gitlab.unauthorized_webhook');
      return;
    }

    const parsed = this.parseEvent(event);
    if (!parsed) return;

    const {
      projectPath,
      iid,
      comment,
      eventType,
      isMR,
      issue,
      mergeRequest,
      isCloseEvent,
      isMerged,
    } = parsed;

    // 4. Handle close/merge events
    if (isCloseEvent) {
      const mergeLabel = isMerged ? 'merge' : 'close';
      getLog().info({ event: mergeLabel, projectPath, iid }, 'gitlab.close_event_received');
      await this.cleanupWorktree(projectPath, iid, isMR, isMerged ?? false);
      return;
    }

    // 5. Self-trigger prevention
    if (comment.includes(BOT_RESPONSE_MARKER)) {
      getLog().debug({ commentAuthor: event.user?.username }, 'gitlab.ignoring_marked_comment');
      return;
    }
    if (event.user?.username?.toLowerCase() === this.botMention.toLowerCase()) {
      getLog().debug({ commentAuthor: event.user.username }, 'gitlab.ignoring_own_comment');
      return;
    }

    // 6. Check @mention
    if (!this.hasMention(comment)) return;

    getLog().info({ eventType, projectPath, iid, isMR }, 'gitlab.webhook_processing');

    // Steps 7-13 wrapped in try-catch so user gets error feedback on setup failures
    try {
      // 7. Conversation + codebase setup
      const conversationId = this.buildConversationId(projectPath, iid, isMR);
      const existingConv = await db.getOrCreateConversation('gitlab', conversationId);
      const isNewConversation = !existingConv.codebase_id;

      const {
        codebase,
        repoPath,
        isNew: isNewCodebase,
      } = await this.getOrCreateCodebaseForRepo(projectPath);

      if (isNewConversation) {
        try {
          await db.updateConversation(existingConv.id, {
            codebase_id: codebase.id,
            cwd: repoPath,
          });
        } catch (updateError) {
          if (updateError instanceof ConversationNotFoundError) {
            getLog().error(
              { conversationId: existingConv.id, codebaseId: codebase.id },
              'gitlab.conversation_codebase_link_failed'
            );
            throw new Error('Failed to set up GitLab conversation - please try again');
          }
          throw updateError;
        }
      }

      // 8. Get default branch
      const defaultBranch = event.project.default_branch;

      // 9. Ensure repo ready
      await this.ensureRepoReady(projectPath, defaultBranch, repoPath, isNewCodebase);

      // 10. Auto-load commands
      if (isNewCodebase) {
        await this.autoDetectAndLoadCommands(repoPath, codebase.id);
      }

      // 11. Isolation hints
      const isolationHints: IsolationHints = {
        workflowType: isMR ? 'pr' : 'issue',
        workflowId: String(iid),
      };

      if (isMR && mergeRequest) {
        isolationHints.prBranch = toBranchName(mergeRequest.source_branch);
        isolationHints.isForkPR = mergeRequest.source_project_id !== mergeRequest.target_project_id;

        getLog().info(
          {
            mrIid: iid,
            sourceBranch: mergeRequest.source_branch,
            isFork: isolationHints.isForkPR,
          },
          'gitlab.mr_head_info'
        );
      }

      // 12. Build message with context
      const strippedComment = this.stripMention(comment);
      let finalMessage = strippedComment;
      let contextToAppend: string | undefined;

      const isSlashCommand = strippedComment.trim().startsWith('/');

      if (isSlashCommand) {
        finalMessage = strippedComment.split('\n')[0].trim();
        getLog().debug({ command: finalMessage }, 'gitlab.slash_command_processing');

        if (isMR && mergeRequest) {
          contextToAppend = `GitLab Merge Request !${String(mergeRequest.iid)}: "${mergeRequest.title}"\nUse 'glab mr view ${String(mergeRequest.iid)}' for full details if needed.`;
        } else if (issue) {
          contextToAppend = `GitLab Issue #${String(issue.iid)}: "${issue.title}"\nUse 'glab issue view ${String(issue.iid)}' for full details if needed.`;
        }
      } else {
        if (isMR && mergeRequest) {
          finalMessage = this.buildMRContext(mergeRequest, strippedComment);
          contextToAppend = `GitLab Merge Request !${String(mergeRequest.iid)}: "${mergeRequest.title}"\nUse 'glab mr view ${String(mergeRequest.iid)}' for full details if needed.`;
        } else if (issue) {
          finalMessage = this.buildIssueContext(issue, strippedComment);
          contextToAppend = `GitLab Issue #${String(issue.iid)}: "${issue.title}"\nUse 'glab issue view ${String(issue.iid)}' for full details if needed.`;
        }
      }

      // 13. Thread context + dispatch
      const commentHistory = await this.fetchCommentHistory(projectPath, iid, isMR);
      const threadContext = commentHistory.length > 0 ? commentHistory.join('\n') : undefined;
      getLog().debug(
        { commentCount: threadContext ? commentHistory.length : 0, conversationId },
        'gitlab.thread_context_loaded'
      );

      await this.lockManager.acquireLock(conversationId, async () => {
        try {
          await handleMessage(this, conversationId, finalMessage, {
            issueContext: contextToAppend,
            threadContext,
            isolationHints,
          });
        } catch (error) {
          const err = toError(error);
          getLog().error({ err, conversationId }, 'gitlab.message_handling_error');
          try {
            const userMessage = classifyAndFormatError(err);
            await this.sendMessage(conversationId, userMessage);
          } catch (sendError) {
            getLog().error(
              { err: toError(sendError), conversationId },
              'gitlab.error_message_send_failed'
            );
          }
        }
      });
    } catch (error) {
      const err = toError(error);
      const conversationId = this.buildConversationId(projectPath, iid, isMR);
      getLog().error({ err, conversationId }, 'gitlab.webhook_setup_failed');
      try {
        const userMessage = classifyAndFormatError(err);
        await this.sendMessage(conversationId, userMessage);
      } catch (sendError) {
        getLog().error(
          { err: toError(sendError), conversationId },
          'gitlab.webhook_setup_error_send_failed'
        );
      }
    }
  }
}
