import { z } from 'zod';
import { configStringSchema, parseConfigLenient, parseConfigSchema } from '../../shared/run-config';

export function parseModelRef(modelRef: string): { providerID: string; modelID: string } | null {
  const slashIndex = modelRef.indexOf('/');
  if (slashIndex <= 0 || slashIndex === modelRef.length - 1) return null;

  const providerID = modelRef.slice(0, slashIndex).trim();
  const modelID = modelRef.slice(slashIndex + 1).trim();
  if (!providerID || !modelID) return null;

  return { providerID, modelID };
}

const modelSchema = configStringSchema.transform((value, ctx) => {
  const parsed = parseModelRef(value);
  if (parsed === null) {
    ctx.addIssue({ code: 'custom', message: "expected '<provider>/<model>'" });
    return z.NEVER;
  }
  return `${parsed.providerID}/${parsed.modelID}`;
});

/** OpenCode takes the same settings at every scope. */
export const configSchema = z.strictObject({
  /** Default model ref in '<provider>/<model>' format, e.g. 'anthropic/claude-3-5-sonnet' */
  model: modelSchema.optional(),
});

/** Community provider defaults for OpenCode (opencode-ai). */
export type OpencodeProviderDefaults = z.output<typeof configSchema>;

/** Parse raw YAML-derived config into typed OpenCode defaults, dropping invalid values. */
export function parseOpencodeConfig(raw: Record<string, unknown>): OpencodeProviderDefaults {
  return parseConfigLenient(configSchema, raw, 'opencode');
}

/** Strict counterpart for authored config: `.archon/config.yaml` and per-run layers. */
export function parseOpencodeConfigStrict(raw: Record<string, unknown>): OpencodeProviderDefaults {
  return parseConfigSchema(configSchema, raw);
}
