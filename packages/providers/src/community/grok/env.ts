const API_KEY_VARS = new Set(['XAI_API_KEY', 'GROK_CODE_XAI_API_KEY', 'GROK_API_KEY']);

/**
 * Environment for the Grok CLI child. Request env overlays process env, then
 * API-key variables are stripped and OAuth-only auth is forced.
 */
export function buildGrokEnv(requestEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !API_KEY_VARS.has(key)) env[key] = value;
  }
  if (requestEnv) {
    for (const [key, value] of Object.entries(requestEnv)) {
      if (!API_KEY_VARS.has(key)) env[key] = value;
    }
  }
  env.GROK_DISABLE_API_KEY_AUTH = '1';
  env.GROK_DISABLE_AUTOUPDATER = '1';
  return env;
}
