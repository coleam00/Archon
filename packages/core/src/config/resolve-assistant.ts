import { access } from 'fs/promises';
import { join } from 'path';
import { getRegisteredProviders } from '@archon/providers';
import { createLogger } from '@archon/paths';
import { loadConfig } from './config-loader';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('config.resolve-assistant');
  return cachedLog;
}

/**
 * Resolve the default AI assistant for a newly registered codebase.
 *
 * Precedence: SDK folder detection (`.codex` / `.claude` in repo) → configured
 * `assistant` from `.archon/config.yaml` → first built-in provider in the
 * registry → hardcoded `'claude'`.
 *
 * Folder detection wins over config because a checked-in `.codex` or `.claude`
 * directory is an explicit per-repo signal from the user.
 */
export async function resolveDefaultAssistant(repoPath: string): Promise<string> {
  const codexFolder = join(repoPath, '.codex');
  const claudeFolder = join(repoPath, '.claude');

  try {
    await access(codexFolder);
    getLog().debug({ path: codexFolder }, 'assistant_detected_codex');
    return 'codex';
  } catch {
    // fall through
  }

  try {
    await access(claudeFolder);
    getLog().debug({ path: claudeFolder }, 'assistant_detected_claude');
    return 'claude';
  } catch {
    // fall through
  }

  try {
    const config = await loadConfig();
    if (config.assistant) {
      getLog().debug({ provider: config.assistant }, 'assistant_default_from_config');
      return config.assistant;
    }
  } catch (err) {
    getLog().warn({ err }, 'config_load_failed_using_builtin_default');
  }

  return getRegisteredProviders().find(p => p.builtIn)?.id ?? 'claude';
}
