/**
 * Config commands — inspect and update configuration.
 *
 * `show`/`assistant` (read)/`path` read the merged config and path helpers
 * directly (no server). `assistant` with a mutation flag goes through
 * `PATCH /api/config/assistants` so the route's merge semantics are preserved
 * (partial updates don't clobber unrelated fields).
 *
 * Secrets are never printed: `config show` redacts env var values to keys only.
 */
import { join } from 'path';
import { loadConfig, getDatabaseType } from '@archon/core';
import { getArchonHome, getArchonConfigPath } from '@archon/paths';
import { createApiClient } from '../api-client';

export async function configShowCommand(cwd: string, json?: boolean): Promise<void> {
  const config = await loadConfig(cwd);

  // Env var VALUES are secret — expose only their keys (mirrors the server's
  // safe-config contract and the codebase env endpoint).
  const envVarKeys = config.envVars ? Object.keys(config.envVars).sort() : [];
  // Build a redacted copy: drop env var values entirely, keep keys only.
  const safe: Record<string, unknown> = { ...config, envVarKeys };
  delete safe.envVars;

  if (json) {
    console.log(JSON.stringify(safe, null, 2));
    return;
  }

  console.log(`Bot name:          ${config.botName}`);
  console.log(`Default assistant: ${config.assistant}`);
  console.log('Assistants:');
  for (const [provider, defaults] of Object.entries(config.assistants ?? {})) {
    const model = (defaults as { model?: string } | undefined)?.model;
    console.log(`  ${provider}${model ? `: ${model}` : ''}`);
  }
  if (config.baseBranch) console.log(`Base branch:       ${config.baseBranch}`);
  if (config.docsPath) console.log(`Docs path:         ${config.docsPath}`);
  console.log(`Max conversations: ${String(config.concurrency.maxConversations)}`);
  console.log(
    `Env var keys:      ${envVarKeys.length > 0 ? envVarKeys.join(', ') : '(none)'} (values hidden)`
  );
}

export async function configAssistantCommand(
  provider: string,
  opts: { model?: string; settingSources?: string; json?: boolean; cwd: string },
  serverUrl?: string
): Promise<void> {
  const hasMutation = opts.model !== undefined || opts.settingSources !== undefined;

  if (!hasMutation) {
    // Read mode: print the assistant's current config block.
    const config = await loadConfig(opts.cwd);
    const block = (config.assistants as Record<string, unknown>)[provider];
    if (block === undefined) {
      console.error(`No config found for assistant "${provider}".`);
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(block, null, 2));
      return;
    }
    console.log(`Assistant: ${provider}`);
    for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
      const display = typeof value === 'string' ? value : JSON.stringify(value);
      console.log(`  ${key}: ${display}`);
    }
    return;
  }

  // Write mode: PATCH only the provided fields so unrelated config is preserved.
  const update: Record<string, unknown> = {};
  if (opts.model !== undefined) update.model = opts.model;
  if (opts.settingSources !== undefined) {
    update.settingSources = opts.settingSources
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }

  const api = createApiClient(serverUrl);
  const result = await api.patch<{ config: unknown }>('/api/config/assistants', {
    assistants: { [provider]: update },
  });
  console.log(`Updated "${provider}" assistant config.`);
  if (opts.json) console.log(JSON.stringify(result, null, 2));
}

export function configPathCommand(json?: boolean): void {
  const home = getArchonHome();
  const configPath = getArchonConfigPath();
  const isPostgres = getDatabaseType() === 'postgresql';
  const databasePath = isPostgres ? '(PostgreSQL via DATABASE_URL)' : join(home, 'archon.db');

  if (json) {
    console.log(
      JSON.stringify(
        { home, configPath, databasePath, database: isPostgres ? 'postgresql' : 'sqlite' },
        null,
        2
      )
    );
    return;
  }

  console.log(`Archon home:  ${home}`);
  console.log(`Config file:  ${configPath}`);
  console.log(`Database:     ${databasePath}`);
}
