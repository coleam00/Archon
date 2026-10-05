import { parseClaudeSettingSources } from '@archon/paths/skills';

import { z } from 'zod';

import { rawAliasesConfigSchema, rawTiersConfigSchema } from './schemas/model-binding';
import type { ValidationConfig } from './validator';

export const validationSourceConfigSchema = z.object({
  assistant: z.string().default('claude'),
  aliases: rawAliasesConfigSchema.optional(),
  tiers: rawTiersConfigSchema.optional(),
  assistants: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  defaults: z
    .object({
      loadDefaultWorkflows: z.boolean().optional(),
      loadDefaultCommands: z.boolean().optional(),
    })
    .optional(),
  commands: z.object({ folder: z.string().optional() }).optional(),
  env: z.record(z.string(), z.string()).optional(),
  envVars: z.record(z.string(), z.string()).optional(),
});

export function workflowValidationConfig(
  config: z.infer<typeof validationSourceConfigSchema>,
  commands: Pick<ValidationConfig, 'loadDefaultCommands' | 'commandFolder'> = {
    loadDefaultCommands: config.defaults?.loadDefaultCommands,
    commandFolder: config.commands?.folder,
  }
): ValidationConfig {
  return {
    ...commands,
    assistant: config.assistant,
    aliases: config.aliases,
    tiers: config.tiers,
    claudeSettingSources: parseClaudeSettingSources(config.assistants?.claude?.settingSources)
      .value,
    claudeConfigDir: (config.envVars ?? config.env)?.CLAUDE_CONFIG_DIR,
  };
}
