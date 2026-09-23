import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from '@hono/zod-openapi';
import { acceptStartReceipt } from '@archon/core/db/resource-starts';
import { getUserById } from '@archon/core/db/users';
import { createLogger } from '@archon/paths';
import { jsonValueSchema } from '@archon/workflows/output-ref';
import type {
  WebhookSourcePlugin,
  WebhookSourcePluginFactory,
  WebhookSourceRequest,
} from '@archon/workflows/webhook-source-plugin';
import { webhookSourceResultSchema } from '@archon/workflows/webhook-source-plugin';

const sourceInstanceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const sourceConfigSchema = z
  .object({
    version: z.literal(1),
    sources: z.array(
      z
        .object({
          sourceInstanceId: sourceInstanceIdSchema,
          module: z.string().min(1),
          config: jsonValueSchema,
        })
        .strict()
    ),
  })
  .strict();

export interface WebhookSourcePluginHost {
  hasSource(sourceInstanceId: string): boolean;
  receive(
    sourceInstanceId: string,
    request: WebhookSourceRequest
  ): Promise<'accepted' | 'malformed' | 'unauthenticated'>;
}

export interface WebhookSourceHostDependencies {
  acceptReceipt: typeof acceptStartReceipt;
  isKnownUser: (id: string) => Promise<boolean>;
}

const defaultDependencies: WebhookSourceHostDependencies = {
  acceptReceipt: acceptStartReceipt,
  isKnownUser: async id => (await getUserById(id)) !== null,
};

const log = createLogger('server.webhook-sources');

function isWebhookSourcePlugin(value: unknown): value is WebhookSourcePlugin {
  return (
    typeof value === 'object' &&
    value !== null &&
    'receive' in value &&
    typeof value.receive === 'function'
  );
}

export async function loadWebhookSourcePlugins(
  configPath: string,
  dependencies: WebhookSourceHostDependencies = defaultDependencies
): Promise<WebhookSourcePluginHost> {
  let parsed: z.infer<typeof sourceConfigSchema>;
  try {
    parsed = sourceConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  } catch (error) {
    log.error({ err: error as Error, stage: 'config' }, 'webhook_source_load_failed');
    throw new Error('Webhook source configuration is invalid', { cause: error });
  }
  const plugins = new Map<string, WebhookSourcePlugin>();

  for (const source of parsed.sources) {
    if (plugins.has(source.sourceInstanceId)) {
      throw new Error(`Duplicate webhook source instance '${source.sourceInstanceId}'`);
    }
    if (!isAbsolute(source.module)) {
      throw new Error(`Webhook source module for '${source.sourceInstanceId}' must be absolute`);
    }
    let loaded: unknown;
    try {
      loaded = await import(pathToFileURL(source.module).href);
    } catch (error) {
      log.error(
        { err: error as Error, sourceInstanceId: source.sourceInstanceId, stage: 'import' },
        'webhook_source_load_failed'
      );
      throw new Error(`Webhook source '${source.sourceInstanceId}' could not be loaded`, {
        cause: error,
      });
    }
    const factory = (loaded as { default?: unknown }).default;
    if (typeof factory !== 'function') {
      throw new Error(
        `Webhook source module for '${source.sourceInstanceId}' has no default factory`
      );
    }
    let plugin: unknown;
    try {
      plugin = await (factory as (input: Parameters<WebhookSourcePluginFactory>[0]) => unknown)({
        sourceInstanceId: source.sourceInstanceId,
        config: source.config,
      });
    } catch (error) {
      log.error(
        { err: error as Error, sourceInstanceId: source.sourceInstanceId, stage: 'factory' },
        'webhook_source_load_failed'
      );
      throw new Error(`Webhook source '${source.sourceInstanceId}' factory failed`, {
        cause: error,
      });
    }
    if (!isWebhookSourcePlugin(plugin)) {
      throw new Error(
        `Webhook source module for '${source.sourceInstanceId}' returned no receiver`
      );
    }
    plugins.set(source.sourceInstanceId, plugin);
  }

  return {
    hasSource: sourceInstanceId => plugins.has(sourceInstanceId),
    async receive(
      sourceInstanceId,
      request
    ): Promise<'accepted' | 'malformed' | 'unauthenticated'> {
      const plugin = plugins.get(sourceInstanceId);
      if (!plugin) throw new Error(`Unknown webhook source instance '${sourceInstanceId}'`);

      let result;
      try {
        result = webhookSourceResultSchema.parse(await plugin.receive(request));
      } catch (error) {
        log.error(
          { err: error as Error, sourceInstanceId, stage: 'normalize' },
          'webhook_source_failed'
        );
        throw new Error(`Webhook source '${sourceInstanceId}' failed to normalize a receipt`, {
          cause: error,
        });
      }
      if (result.status === 'rejected') {
        log.warn(
          {
            sourceInstanceId,
            stage: 'authenticate',
            reason: result.reason,
            attemptId: randomUUID(),
          },
          'webhook_source_rejected'
        );
        return 'unauthenticated';
      }
      if (result.acceptance.receipt.sourceInstanceId !== sourceInstanceId) {
        log.error({ sourceInstanceId, stage: 'identity' }, 'webhook_source_failed');
        throw new Error(
          `Webhook source '${sourceInstanceId}' returned a receipt for another source`
        );
      }
      for (const binding of result.acceptance.bindings) {
        if (!(await dependencies.isKnownUser(binding.runAsUserId))) {
          log.error({ sourceInstanceId, stage: 'run_as' }, 'webhook_source_failed');
          throw new Error(`Webhook source '${sourceInstanceId}' resolved an unknown run-as user`);
        }
      }
      try {
        await dependencies.acceptReceipt(result.acceptance);
      } catch (error) {
        log.error(
          { err: error as Error, sourceInstanceId, stage: 'persist' },
          'webhook_source_failed'
        );
        throw new Error(`Webhook source '${sourceInstanceId}' receipt persistence failed`, {
          cause: error,
        });
      }
      return result.acceptance.outcome === 'malformed' ? 'malformed' : 'accepted';
    },
  };
}
