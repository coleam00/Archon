import { unlink } from 'fs/promises';
import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AttachedFile, HandleMessageContext } from '@archon/core';
import { generateTitleForUser, resolveTitleRequest } from '@archon/core';
import { parseWorkflowRunConfig } from '@archon/core/config';
import * as messageDb from '@archon/core/db/messages';
import { getArchonWorkspacesPath } from '@archon/paths';
import { isValidWorkflowName } from '@archon/workflows/command-validation';
import { TIER_NAMES, isTierName } from '@archon/workflows/model-validation';
import type { RunModelOverrides } from '@archon/workflows/model-validation';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import type { WebAdapter } from '../adapters/web';
import { type OrchestratorDispatch, persistUploadedFiles } from './api-message-dispatch';
import { authorizeDispatchConversation } from './api-request-auth';
import { apiError, getLog, jsonError, openApiRouteRegistrar } from './api-route-kit';
import { dispatchResponseSchema } from './schemas/conversation.schemas';

// Body validation is handled manually in the handler (multipart vs JSON
// branching), mirroring sendMessageRoute. The OpenAPI spec describes the
// shapes via the description; declaring `request.body` would force JSON
// validation to run on multipart payloads and reject them.
const runWorkflowRoute = createRoute({
  method: 'post',
  path: '/api/workflows/{name}/run',
  tags: ['Workflows'],
  summary: 'Run a workflow via the orchestrator (JSON or multipart with file uploads)',
  description:
    'Accepts `application/json` with `{ conversationId, message, inputs?, config?, tiers?, aliases? }` or ' +
    '`multipart/form-data` with `conversationId`, `message`, optional `inputs` and `config` fields ' +
    'holding their objects JSON-encoded, optional `tiers` and `aliases` JSON object fields, ' +
    'and optional file attachments (max 5 files, ' +
    "10 MB each). `inputs` supplies values for the workflow's declared `inputs:` " +
    '(#2554); it is validated against the declaration before any worktree, clone, or AI ' +
    'cost, so a missing required input or an undeclared key is refused up front. `config` ' +
    'supplies a sparse runtime layer; `tiers` and `aliases` rebind named model presets above it. ' +
    'Caller-supplied filesystem config paths are rejected.',
  request: {
    params: z.object({ name: z.string() }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchResponseSchema } },
      description: 'Accepted',
    },
    400: jsonError('Bad request'),
    401: jsonError('Authentication required'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
    503: jsonError('Identity backend unavailable'),
  },
});

/**
 * Validate a run request's declared-inputs map (#2554): a flat object whose every
 * value is a string, which is exactly the shape `readSubrunMetadata` will accept back
 * off the run row. Refuse anything else here rather than let it be persisted into a
 * shape the engine silently reads as absent.
 *
 * An empty object resolves to `undefined` so a caller sending `{}` is treated as
 * having supplied nothing, taking every declared default.
 */
function parseRunInputsField(
  raw: unknown
): { ok: true; inputs?: Record<string, string> } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'inputs must be an object mapping input names to strings' };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  const badKey = entries.find(([, value]) => typeof value !== 'string')?.[0];
  if (badKey !== undefined) {
    return { ok: false, error: `inputs value for '${badKey}' must be a string` };
  }
  return {
    ok: true,
    inputs: entries.length > 0 ? (raw as Record<string, string>) : undefined,
  };
}

function parseRunModelOverridesFields(
  rawTiers: unknown,
  rawAliases: unknown
): { ok: true; overrides?: RunModelOverrides } | { ok: false; error: string } {
  const parseMap = (
    raw: unknown,
    label: 'tiers' | 'aliases'
  ): { ok: true; value?: Record<string, string> } | { ok: false; error: string } => {
    if (raw === undefined || raw === null) return { ok: true };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `${label} must be an object mapping names to model specs` };
    }
    const entries = Object.entries(raw as Record<string, unknown>);
    for (const [name, spec] of entries) {
      if (typeof spec !== 'string' || spec.trim().length === 0) {
        return { ok: false, error: `${label} value for '${name}' must be a non-empty string` };
      }
      if (label === 'tiers' && !isTierName(name)) {
        return {
          ok: false,
          error: `Invalid tier '${name}'. Supported tiers: ${TIER_NAMES.join(', ')}`,
        };
      }
      if (label === 'aliases' && !name.startsWith('@')) {
        return { ok: false, error: `Alias '${name}' must start with '@'` };
      }
    }
    return {
      ok: true,
      value: entries.length > 0 ? (raw as Record<string, string>) : undefined,
    };
  };

  const tiers = parseMap(rawTiers, 'tiers');
  if (!tiers.ok) return tiers;
  const aliases = parseMap(rawAliases, 'aliases');
  if (!aliases.ok) return aliases;
  if (!tiers.value && !aliases.value) return { ok: true };
  return {
    ok: true,
    overrides: {
      ...(tiers.value ? { tiers: tiers.value } : {}),
      ...(aliases.value ? { aliases: aliases.value } : {}),
    } as RunModelOverrides,
  };
}

export function registerWorkflowRunLaunchRoute(
  app: OpenAPIHono,
  {
    webAdapter,
    dispatchToOrchestrator,
  }: { webAdapter: WebAdapter; dispatchToOrchestrator: OrchestratorDispatch }
): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

  // POST /api/workflows/:name/run - Run a workflow via the orchestrator
  //
  // Accepts either:
  //   - application/json: { conversationId, message, inputs?, tiers?, aliases? }
  //   - multipart/form-data: those maps JSON-encoded + files[] (≤5, ≤10MB each)
  //
  // Multipart matches /api/conversations/:id/message so the console's draft
  // run input can attach screenshots / stack traces / paste-blobs the same
  // way a freeform chat message can.
  registerOpenApiRoute(runWorkflowRoute, async c => {
    const workflowName = c.req.param('name') ?? '';
    if (!isValidWorkflowName(workflowName)) {
      return apiError(c, 400, 'Invalid workflow name');
    }

    let message: string;
    let conversationId: string;
    let workflowInputs: Record<string, string> | undefined;
    let workflowModelOverrides: RunModelOverrides | undefined;
    let workflowRunConfig: WorkflowRunConfigInput | undefined;
    // Between-run continuation (#2747): run-id only — no name-based newest-wins.
    let adoptRunId: string | undefined;
    let supersedesRunId: string | undefined;
    let fileEntries: File[] = [];

    const contentType = c.req.header('content-type') ?? '';

    if (contentType.includes('multipart/form-data')) {
      let body: Record<string, string | File | (string | File)[]>;
      try {
        body = await c.req.parseBody({ all: true });
      } catch (parseErr: unknown) {
        getLog().warn({ err: parseErr }, 'run_workflow.multipart_parse_failed');
        return apiError(c, 400, 'Invalid multipart form data');
      }

      const rawMessage = body.message;
      const rawConv = body.conversationId;
      if (typeof rawMessage !== 'string' || !rawMessage) {
        return apiError(c, 400, 'message must be a non-empty string');
      }
      if (typeof rawConv !== 'string' || !rawConv || !/^[\w-]+$/.test(rawConv)) {
        return apiError(c, 400, 'conversationId must be a non-empty alphanumeric string');
      }
      message = rawMessage;
      conversationId = rawConv;

      if (body.configPath !== undefined) {
        return apiError(c, 400, 'configPath is not supported; send validated config content');
      }

      // Declared inputs (#2554). A form field can only be a string, so the map travels
      // JSON-encoded. A malformed field is refused rather than ignored — silently
      // dropping it would start the run without the values the caller thought it sent.
      const rawInputs = body.inputs;
      if (rawInputs !== undefined) {
        if (typeof rawInputs !== 'string') {
          return apiError(c, 400, 'inputs must be a JSON-encoded object of string values');
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(rawInputs);
        } catch (parseErr: unknown) {
          getLog().warn({ err: parseErr, workflowName }, 'run_workflow.inputs_parse_failed');
          return apiError(c, 400, 'inputs must be a JSON-encoded object of string values');
        }
        const parsed = parseRunInputsField(decoded);
        if (!parsed.ok) return apiError(c, 400, parsed.error);
        workflowInputs = parsed.inputs;
      }

      const decodeObjectField = (
        raw: string | File | (string | File)[] | undefined,
        label: 'tiers' | 'aliases'
      ): { ok: true; value?: unknown } | { ok: false; error: string } => {
        if (raw === undefined) return { ok: true };
        if (typeof raw !== 'string') {
          return { ok: false, error: `${label} must be a JSON-encoded object` };
        }
        try {
          return { ok: true, value: JSON.parse(raw) as unknown };
        } catch (parseErr: unknown) {
          getLog().warn(
            { err: parseErr, workflowName, field: label },
            'run_workflow.model_overrides_parse_failed'
          );
          return { ok: false, error: `${label} must be a JSON-encoded object` };
        }
      };
      const decodedTiers = decodeObjectField(body.tiers, 'tiers');
      if (!decodedTiers.ok) return apiError(c, 400, decodedTiers.error);
      const decodedAliases = decodeObjectField(body.aliases, 'aliases');
      if (!decodedAliases.ok) return apiError(c, 400, decodedAliases.error);
      const parsedOverrides = parseRunModelOverridesFields(
        decodedTiers.value,
        decodedAliases.value
      );
      if (!parsedOverrides.ok) return apiError(c, 400, parsedOverrides.error);
      workflowModelOverrides = parsedOverrides.overrides;

      if (body.config !== undefined) {
        if (typeof body.config !== 'string') {
          return apiError(c, 400, 'config must be a JSON-encoded object');
        }
        let decodedConfig: unknown;
        try {
          decodedConfig = JSON.parse(body.config) as unknown;
        } catch (parseErr: unknown) {
          getLog().warn({ err: parseErr, workflowName }, 'run_workflow.config_parse_failed');
          return apiError(c, 400, 'config must be a JSON-encoded object');
        }
        try {
          workflowRunConfig = parseWorkflowRunConfig(decodedConfig, {
            kind: 'http',
            label: 'inline',
          });
        } catch (error) {
          return apiError(c, 400, (error as Error).message);
        }
      }

      const rawFiles = body.files;
      const fileList: (string | File)[] = Array.isArray(rawFiles)
        ? rawFiles
        : rawFiles !== undefined
          ? [rawFiles]
          : [];
      fileEntries = fileList.filter((e): e is File => e instanceof File);
    } else {
      let body: {
        conversationId?: unknown;
        message?: unknown;
        inputs?: unknown;
        tiers?: unknown;
        aliases?: unknown;
        config?: unknown;
        configPath?: unknown;
        adopt_run_id?: unknown;
        supersedes_run_id?: unknown;
      };
      try {
        body = await c.req.json();
      } catch (parseErr: unknown) {
        getLog().warn({ err: parseErr }, 'run_workflow.json_parse_failed');
        return apiError(c, 400, 'Invalid JSON in request body');
      }
      if (typeof body.conversationId !== 'string' || !body.conversationId) {
        return apiError(c, 400, 'conversationId must be a non-empty string');
      }
      if (typeof body.message !== 'string' || !body.message) {
        return apiError(c, 400, 'message must be a non-empty string');
      }
      if (body.configPath !== undefined) {
        return apiError(c, 400, 'configPath is not supported; send validated config content');
      }
      const parsed = parseRunInputsField(body.inputs);
      if (!parsed.ok) return apiError(c, 400, parsed.error);
      workflowInputs = parsed.inputs;
      for (const [field, target] of [
        ['adopt_run_id', 'adopt'],
        ['supersedes_run_id', 'supersede'],
      ] as const) {
        const raw = body[field];
        if (raw === undefined) continue;
        if (typeof raw !== 'string' || !raw) {
          return apiError(c, 400, `${field} must be a non-empty run id`);
        }
        if (target === 'adopt') adoptRunId = raw;
        else supersedesRunId = raw;
      }
      if (adoptRunId && supersedesRunId) {
        return apiError(c, 400, 'adopt_run_id and supersedes_run_id are mutually exclusive');
      }
      const parsedOverrides = parseRunModelOverridesFields(body.tiers, body.aliases);
      if (!parsedOverrides.ok) return apiError(c, 400, parsedOverrides.error);
      workflowModelOverrides = parsedOverrides.overrides;
      if (body.config !== undefined) {
        try {
          workflowRunConfig = parseWorkflowRunConfig(body.config, {
            kind: 'http',
            label: 'inline',
          });
        } catch (error) {
          return apiError(c, 400, (error as Error).message);
        }
      }
      conversationId = body.conversationId;
      message = body.message;
    }

    // The conversation id arrives in the body, so attachments are written only
    // once it is known that the caller may reach this conversation.
    const access = await authorizeDispatchConversation(c, conversationId);
    if ('error' in access) return access.error;
    const conv = access.conversation;
    const actor = access.actor;
    const userId = actor.kind === 'user' ? actor.userId : undefined;

    let savedFiles: AttachedFile[] = [];
    if (fileEntries.length > 0) {
      const result = await persistUploadedFiles(conversationId, fileEntries);
      if (!result.ok) {
        return apiError(c, result.status, result.error);
      }
      savedFiles = result.savedFiles;
      getLog().info(
        { conversationId, fileCount: savedFiles.length, workflowName },
        'run_workflow.files_uploaded'
      );
    }

    try {
      // Persist user message and register DB ID (same as message endpoint).
      // File metadata (name/mime/size — no path, since the on-disk file is
      // ephemeral) goes into message metadata when present.
      if (conv) {
        try {
          const meta =
            savedFiles.length > 0
              ? {
                  files: savedFiles.map(f => ({
                    name: f.name,
                    mimeType: f.mimeType,
                    size: f.size,
                  })),
                }
              : undefined;
          await messageDb.addMessage(conv.id, 'user', message, meta, userId);
        } catch (e: unknown) {
          getLog().error({ err: e, conversationId: conv.id }, 'message_persistence_failed');
          for (const file of savedFiles) {
            await unlink(file.path).catch((err: NodeJS.ErrnoException) => {
              if (err.code !== 'ENOENT') {
                getLog().warn(
                  { err, filePath: file.path, conversationId },
                  'upload.rollback_failed'
                );
              }
            });
          }
          return apiError(c, 500, 'Failed to save workflow request to history');
        }
        webAdapter.setConversationDbId(conversationId, conv.id);
        if (!conv.title) {
          // Resolve the `small` tier (config tiers + per-user prefs) instead of the raw
          // assistant default (#1855). Both calls never throw.
          void resolveTitleRequest(conv.ai_assistant_type, userId).then(titleRequest =>
            generateTitleForUser(
              conv.id,
              message,
              titleRequest,
              getArchonWorkspacesPath(),
              userId,
              workflowName
            )
          );
        }
      }

      // The message and every run option ride typed fields, never a chat command
      // string: tokenizing the message would rewrite it and let a word in it set
      // `--force` (#4159), and encoding inputs would invent a chat grammar (#2554/#2555).
      const extraContext: Omit<HandleMessageContext, 'isolationHints'> = {
        actor,
        workflowName,
        ...(savedFiles.length > 0 ? { attachedFiles: savedFiles } : {}),
        ...(workflowInputs ? { workflowInputs } : {}),
        ...(workflowModelOverrides ? { workflowModelOverrides } : {}),
        ...(workflowRunConfig ? { workflowRunConfig } : {}),
        ...(adoptRunId ? { workflowAdoptRunId: adoptRunId } : {}),
        ...(supersedesRunId ? { workflowSupersedesRunId: supersedesRunId } : {}),
      };
      const filesToCleanup = savedFiles.length > 0 ? savedFiles : undefined;
      const result = await dispatchToOrchestrator(
        conversationId,
        message,
        extraContext,
        filesToCleanup
      );
      return c.json(result);
    } catch (error) {
      getLog().error({ err: error }, 'run_workflow_failed');
      return apiError(c, 500, 'Failed to run workflow');
    }
  });
}
