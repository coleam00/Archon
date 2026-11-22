import { z } from 'zod';
import { configStringSchema, parseConfigLenient, parseConfigSchema } from '../../shared/run-config';

/** Community provider defaults for ZCode (zcode CLI, headless -p). */
export const configSchema = z.strictObject({
  /** Path to the zcode binary; default resolves from PATH. */
  cliPath: configStringSchema.optional(),
  /** Permission mode for every headless call (zcode --mode); CLI default is yolo for -p. */
  mode: z.enum(['build', 'edit', 'plan', 'yolo', 'guarded']).optional(),
  /** Tool names removed from every call via --disallowed-tools. */
  disallowedTools: z.array(configStringSchema).readonly().optional(),
});

export type ZcodeProviderDefaults = z.output<typeof configSchema>;

/** Parse raw YAML-derived config into typed ZCode defaults, dropping invalid values. */
export function parseZcodeConfig(raw: Record<string, unknown>): ZcodeProviderDefaults {
  return parseConfigLenient(configSchema, raw, 'zcode');
}

/** Strict counterpart for authored config: `.archon/config.yaml` and per-run layers. */
export function parseZcodeConfigStrict(raw: Record<string, unknown>): ZcodeProviderDefaults {
  return parseConfigSchema(configSchema, raw);
}
