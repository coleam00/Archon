/**
 * Zod schemas for the agent registry API endpoints.
 *
 * Agents live in `~/.claude/agents/<name>.md` (global) and
 * `<cwd>/.claude/agents/<name>.md` (project). Project entries override global
 * by name. Each agent is a single .md file with YAML frontmatter
 * (`name`, `description` required) and a markdown body that becomes the
 * agent's system prompt.
 */

import { z } from '@hono/zod-openapi';

/** Source of a discovered agent. */
export const agentSourceSchema = z.enum(['global', 'project']).openapi('AgentSource');

/** Agent lifecycle status (frontmatter `status` field). */
export const agentStatusSchema = z.enum(['active', 'draft', 'archived']).openapi('AgentStatus');

/** Per-agent discovery error returned alongside the list. */
export const agentLoadErrorSchema = z
  .object({
    name: z.string(),
    source: agentSourceSchema,
    path: z.string(),
    error: z.string(),
  })
  .openapi('AgentLoadError');

/** Lightweight summary record used by list and editor headers. */
export const agentSummarySchema = z
  .object({
    name: z.string(),
    description: z.string(),
    source: agentSourceSchema,
    path: z.string(),
    isSymlink: z.boolean(),
    realPath: z.string().nullable(),
    mtime: z.string(),
    status: agentStatusSchema,
    model: z.string().nullable(),
    skillCount: z.number().int().nonnegative(),
    toolCount: z.number().int().nonnegative(),
    parseError: z.string().nullable(),
  })
  .openapi('AgentSummary');

/** Full agent record including parsed frontmatter and markdown body. */
export const agentDetailSchema = agentSummarySchema
  .extend({
    frontmatter: z.record(z.unknown()),
    body: z.string(),
  })
  .openapi('AgentDetail');

/** GET /api/agents response. */
export const agentListResponseSchema = z
  .object({
    agents: z.array(agentSummarySchema),
    errors: z.array(agentLoadErrorSchema).optional(),
  })
  .openapi('AgentListResponse');

/** POST /api/agents request body. */
export const createAgentBodySchema = z
  .object({
    name: z.string(),
    source: agentSourceSchema,
    description: z.string(),
    cwd: z.string().optional(),
  })
  .openapi('CreateAgentBody');

/** PUT /api/agents/:name request body. */
export const saveAgentBodySchema = z
  .object({
    source: agentSourceSchema,
    cwd: z.string().optional(),
    frontmatter: z.record(z.unknown()),
    body: z.string(),
  })
  .openapi('SaveAgentBody');

/** DELETE /api/agents/:name response. */
export const deleteAgentResponseSchema = z
  .object({ deleted: z.boolean(), name: z.string() })
  .openapi('DeleteAgentResponse');

/** Single MCP server status reported by the validate smoke run. */
export const validateMcpServerSchema = z
  .object({
    name: z.string(),
    status: z.string(),
  })
  .openapi('ValidateMcpServer');

/** POST /api/agents/:name/validate response. */
export const validateAgentResponseSchema = z
  .object({
    /** Overall pass/fail. False if any error occurred during the smoke run. */
    ok: z.boolean(),
    /** Effective model id reported by the SDK after resolution. */
    model: z.string().nullable(),
    /** Active tool list reported by the SDK system.init message. */
    activeTools: z.array(z.string()),
    /** MCP server connection statuses. */
    mcpServers: z.array(validateMcpServerSchema),
    /** Skill names actually loaded by the SDK. */
    skillsLoaded: z.array(z.string()),
    /** Env vars referenced by mcp config but missing in the environment. */
    missingEnvVars: z.array(z.string()),
    /** Free-text warnings (e.g. Haiku + MCP). */
    warnings: z.array(z.string()),
    /** Hard errors that prevented the smoke run. */
    errors: z.array(z.string()),
    /** Sample assistant text, when the smoke prompt produced a reply. */
    sampleReply: z.string().nullable(),
    /** Total cost in USD reported by the SDK result event. */
    costUsd: z.number().nullable(),
  })
  .openapi('ValidateAgentResponse');

/** GET /api/agents/_template response. */
export const agentTemplateResponseSchema = z
  .object({
    content: z.string(),
    path: z.string(),
    source: z.enum(['project', 'global']),
    preExisting: z.boolean(),
  })
  .openapi('AgentTemplateResponse');

/** PUT /api/agents/_template request body. */
export const saveAgentTemplateBodySchema = z
  .object({
    content: z.string(),
    cwd: z.string().optional(),
  })
  .openapi('SaveAgentTemplateBody');

/** Acknowledgement returned by template save. */
export const saveAgentTemplateResponseSchema = z
  .object({
    path: z.string(),
    source: z.enum(['project', 'global']),
  })
  .openapi('SaveAgentTemplateResponse');

/** POST /api/agents/:name/chat request body — one-shot, no session. */
export const agentChatBodySchema = z
  .object({
    source: agentSourceSchema,
    cwd: z.string().optional(),
    message: z.string().min(1),
  })
  .openapi('AgentChatBody');

/** POST /api/agents/:name/chat response. */
export const agentChatResponseSchema = z
  .object({
    reply: z.string(),
  })
  .openapi('AgentChatResponse');
