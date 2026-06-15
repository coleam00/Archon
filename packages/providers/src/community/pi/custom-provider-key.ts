import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the API-key environment-variable name for a *custom* Pi provider —
 * one the user defined in pi's `models.json` (e.g. a self-hosted, OpenAI-
 * compatible gateway) that is not one of pi-ai's built-in backends listed in
 * `PI_PROVIDER_ENV_VARS` (`pi-vendor-map.generated.ts`).
 *
 * Pi's `models.json` provider entries declare their key as a `"$ENV_VAR"`
 * reference, for example:
 *
 * ```json
 * {
 *   "providers": {
 *     "myorg": {
 *       "baseUrl": "https://gateway.example/v1",
 *       "api": "openai-completions",
 *       "apiKey": "$MYORG_API_KEY"
 *     }
 *   }
 * }
 * ```
 *
 * Returning `"MYORG_API_KEY"` lets the Pi provider inject that key via
 * `authStorage.setRuntimeApiKey`, so any custom OpenAI-compatible provider
 * authenticates without a per-provider code change. Previously only built-in
 * SDK backends (those in the generated vendor map) had their keys forwarded,
 * so requests to user-defined gateways failed upstream with `401`.
 *
 * Reads `$PI_CODING_AGENT_DIR/models.json`, falling back to
 * `~/.pi/agent/models.json` — the same file pi's own CLI reads. Best-effort:
 * returns `undefined` on any missing/unreadable/malformed file, or when the
 * provider's `apiKey` is absent or not a `"$VAR"` reference, so callers fall
 * through to the existing no-credentials path.
 */
export function customProviderApiKeyEnvVar(
  provider: string,
  configDir: string = process.env.PI_CODING_AGENT_DIR?.trim() ||
    join(homedir(), '.pi', 'agent')
): string | undefined {
  try {
    const raw = readFileSync(join(configDir, 'models.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      providers?: Record<string, { apiKey?: unknown }>;
    };
    const apiKey = parsed.providers?.[provider]?.apiKey;
    if (typeof apiKey === 'string' && apiKey.startsWith('$') && apiKey.length > 1) {
      return apiKey.slice(1);
    }
  } catch {
    // No models.json, unreadable, or malformed JSON — treat as "no custom var".
  }
  return undefined;
}
