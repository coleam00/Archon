import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getArchonConfigPath } from '@archon/paths/archon-paths';
import { dispatchForge, type ForgeOperationAudit } from '@archon/forge/dispatch';
import { forgePluginConfigSchema } from '@archon/forge/plugin-config';
import { forgeRequestSchema, type ForgeResponse } from '@archon/forge/operations';
import { writeJsonLine } from '../utils/stdout';

async function readForgeConfig(): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(getArchonConfigPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const config: unknown = Bun.YAML.parse(source);
  if (config === null) return {};
  if (typeof config !== 'object' || Array.isArray(config))
    throw new Error('Archon config must be an object');
  return 'forge' in config ? config.forge : {};
}

async function persistAudit(audit: ForgeOperationAudit, runId: string): Promise<void> {
  const { persistWorkflowEvent } = await import('@archon/core/db/workflow-events');
  const { closeDatabase } = await import('@archon/core/db/connection');
  try {
    await persistWorkflowEvent({
      workflow_run_id: runId,
      event_type: 'integration_operation',
      data: { integration: 'forge', ...audit },
    });
  } finally {
    await closeDatabase();
  }
}

export async function forgeCommand(
  subcommand: string | undefined,
  options: { cwd: string; data?: string; command: readonly [string, ...string[]] },
  dependencies: {
    dispatch?: typeof dispatchForge;
    readConfig?: () => Promise<unknown>;
    audit?: typeof persistAudit;
    write?: typeof writeJsonLine;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<number> {
  const write = dependencies.write ?? writeJsonLine;
  const env = dependencies.env ?? process.env;
  const operationId = randomUUID();
  let response: ForgeResponse;
  try {
    const op = subcommand === 'checks' ? 'checks.state' : subcommand;
    const supplied: unknown = options.data ? JSON.parse(options.data) : {};
    if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)) {
      throw new Error('--data must be a JSON object');
    }
    const request = forgeRequestSchema.parse({ ...supplied, operationId, op });
    const config = forgePluginConfigSchema.parse(
      await (dependencies.readConfig ?? readForgeConfig)()
    );
    const [command, ...args] = options.command;
    // A configured implementation can replace the default producer by name. It
    // still goes through exactly the same metadata and operation process protocol.
    const configuredGithub =
      config.plugins.some(plugin => plugin.plugin === 'github') ||
      Object.values(config.hosts).some(
        value => typeof value !== 'string' && value.plugin === 'github' && value.command
      );
    if (!configuredGithub) {
      config.plugins.push({ plugin: 'github', command, args: [...args, 'forge-plugin', 'github'] });
    }
    const result = await (dependencies.dispatch ?? dispatchForge)(request, { config, env });
    response = result.response;
    if (env.WORKFLOW_ID) {
      try {
        await (dependencies.audit ?? persistAudit)(result.audit, env.WORKFLOW_ID);
      } catch {
        // Retain the actual operation outcome on stdout. Audit failure is a
        // separate failure and never rewrites an observed result as a refusal.
        await write(response);
        process.stderr.write(
          `Forge operation ${operationId} completed but its run audit could not be persisted.\n`
        );
        return 2;
      }
    }
  } catch (error) {
    response = {
      operationId,
      ok: false,
      error: {
        kind: 'invalid_request',
        message:
          error instanceof SyntaxError
            ? 'Invalid JSON input or configuration'
            : 'Invalid forge request or configuration; see archon forge --help',
      },
    };
  }
  await write(response);
  return response.ok ? 0 : 1;
}
