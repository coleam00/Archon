/**
 * Zod schemas for the skill registry API endpoints.
 *
 * Skills live in `~/.claude/skills/<name>/` (global) and
 * `<cwd>/.claude/skills/<name>/` (project). Project entries override global by
 * name. Each skill is a directory with at least a `SKILL.md` file containing
 * YAML frontmatter (`name`, `description`) plus a markdown body, and may have
 * optional `scripts/`, `references/`, `assets/` subdirectories.
 */

import { z } from '@hono/zod-openapi';

/** Source of a discovered skill — global (~/.claude/skills) vs project (<cwd>/.claude/skills). */
export const skillSourceSchema = z.enum(['global', 'project']).openapi('SkillSource');

/** Per-skill discovery error returned alongside the list. */
export const skillLoadErrorSchema = z
  .object({
    name: z.string(),
    source: skillSourceSchema,
    path: z.string(),
    error: z.string(),
  })
  .openapi('SkillLoadError');

/** Lightweight summary record used by list and editor headers. */
export const skillSummarySchema = z
  .object({
    name: z.string(),
    description: z.string(),
    source: skillSourceSchema,
    path: z.string(),
    isSymlink: z.boolean(),
    realPath: z.string().nullable(),
    mtime: z.string(),
    hasScripts: z.boolean(),
    hasReferences: z.boolean(),
    hasAssets: z.boolean(),
    prefix: z.string().nullable(),
    parseError: z.string().nullable(),
  })
  .openapi('SkillSummary');

/** A node in the skill's recursive file tree. */
export const skillFileNodeSchema = z
  .object({
    path: z.string(),
    isDirectory: z.boolean(),
    size: z.number().int().nonnegative().optional(),
    isSymlink: z.boolean().optional(),
  })
  .openapi('SkillFileNode');

/** Full skill record including parsed frontmatter, body, and file tree. */
export const skillDetailSchema = skillSummarySchema
  .extend({
    frontmatter: z.record(z.unknown()),
    body: z.string(),
    files: z.array(skillFileNodeSchema),
  })
  .openapi('SkillDetail');

/** GET /api/skills response. */
export const skillListResponseSchema = z
  .object({
    skills: z.array(skillSummarySchema),
    errors: z.array(skillLoadErrorSchema).optional(),
  })
  .openapi('SkillListResponse');

/** POST /api/skills request body. */
export const createSkillBodySchema = z
  .object({
    name: z.string(),
    source: skillSourceSchema,
    cwd: z.string().optional(),
    frontmatter: z.record(z.unknown()),
    body: z.string(),
  })
  .openapi('CreateSkillBody');

/** PUT /api/skills/:name request body. */
export const saveSkillBodySchema = z
  .object({
    source: skillSourceSchema,
    cwd: z.string().optional(),
    frontmatter: z.record(z.unknown()),
    body: z.string(),
  })
  .openapi('SaveSkillBody');

/** DELETE /api/skills/:name response. */
export const deleteSkillResponseSchema = z
  .object({ deleted: z.boolean(), name: z.string() })
  .openapi('DeleteSkillResponse');

/** GET /api/skills/:name/files response. */
export const skillFileListResponseSchema = z
  .object({ files: z.array(skillFileNodeSchema) })
  .openapi('SkillFileListResponse');

/** PUT /api/skills/:name/files/* request body (text content). Binary uploads use multipart. */
export const writeSkillFileBodySchema = z
  .object({
    content: z.string(),
    encoding: z.enum(['utf8', 'base64']).optional(),
  })
  .openapi('WriteSkillFileBody');

/** Generic write/delete acknowledgement. */
export const skillFileMutationResponseSchema = z
  .object({ ok: z.boolean(), path: z.string() })
  .openapi('SkillFileMutationResponse');
