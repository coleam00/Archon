import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  getRegisteredProviders,
  getRegistration,
  InvalidProviderRunConfigError,
  isRegisteredProvider,
} from '@archon/providers';
import {
  normalizeStrictRunModelPreset,
  RunModelPresetValidationError,
  type ModelAliasPreset,
} from '@archon/workflows/model-validation';
import {
  workflowRunConfigLayerSchema,
  type WorkflowRunConfigInput,
  type WorkflowRunConfigLayer,
  type WorkflowRunConfigMetadata,
  type WorkflowRunConfigSource,
} from '@archon/workflows/schemas/run-config';
import { decryptToken, encryptToken, getEncryptionKey } from '../utils/token-crypto';
import type { GlobalConfig, RepoConfig } from './config-types';

type ConfigKey = keyof GlobalConfig | keyof RepoConfig;
type KeyClassification = { kind: 'runtime' } | { kind: 'unavailable'; reason: string };

const keyClassifications = {
  assistant: { kind: 'runtime' },
  defaultAssistant: { kind: 'runtime' },
  assistants: { kind: 'runtime' },
  aliases: { kind: 'runtime' },
  tiers: { kind: 'runtime' },
  workflows: { kind: 'runtime' },
  docs: { kind: 'runtime' },
  env: { kind: 'runtime' },
  commands: {
    kind: 'unavailable',
    reason: 'workflow and command discovery already ran before run dispatch',
  },
  defaults: {
    kind: 'unavailable',
    reason: 'default workflow and command discovery already ran before run dispatch',
  },
  worktree: {
    kind: 'unavailable',
    reason: 'worktree isolation and its base branch are resolved before run dispatch',
  },
  container: {
    kind: 'unavailable',
    reason: 'container isolation is resolved before run dispatch',
  },
  botName: {
    kind: 'unavailable',
    reason: 'the bot identity is process-scoped and has no per-run consumer',
  },
  streaming: {
    kind: 'unavailable',
    reason: 'platform response streaming is process-scoped and has no per-run consumer',
  },
  paths: {
    kind: 'unavailable',
    reason: 'workspace and worktree paths are resolved before run dispatch',
  },
  concurrency: {
    kind: 'unavailable',
    reason: 'conversation concurrency is process-scoped and has no per-run consumer',
  },
  recommendedWorkflows: {
    kind: 'unavailable',
    reason: 'recommended workflows are listing-only and have no run consumer',
  },
} as const satisfies Record<ConfigKey, KeyClassification>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validationError(error: { issues: { path: PropertyKey[]; message: string }[] }): Error {
  const issue = error.issues[0];
  const path = issue?.path.length ? issue.path.map(String).join('.') : 'document';
  return new Error(`Invalid run config at '${path}': ${issue?.message ?? 'invalid value'}`);
}

function assertRegisteredProvider(provider: string, path: string): void {
  if (isRegisteredProvider(provider)) return;
  const available = getRegisteredProviders()
    .map(entry => entry.id)
    .sort()
    .join(', ');
  throw new Error(
    `Invalid run config at '${path}': unknown provider '${provider}'.` +
      (available ? ` Available: ${available}.` : ' No providers are registered.')
  );
}

function normalizePreset(path: string, preset: ModelAliasPreset): ModelAliasPreset {
  try {
    return normalizeStrictRunModelPreset(preset);
  } catch (error) {
    if (!(error instanceof RunModelPresetValidationError)) throw error;
    const issuePath = `${path}.${error.issue.field}`;
    if (error.issue.kind === 'unknown-provider') {
      const available = getRegisteredProviders()
        .map(entry => entry.id)
        .sort()
        .join(', ');
      throw new Error(
        `Invalid run config at '${issuePath}': unknown provider '${error.issue.provider}'.` +
          (available ? ` Available: ${available}.` : ' No providers are registered.')
      );
    }
    throw new Error(`Invalid run config at '${issuePath}': ${error.message}.`);
  }
}

/** Validate and normalize constraints owned by the live provider registry and lifecycle. */
function normalizeRunConfigSemantics(layer: WorkflowRunConfigLayer): WorkflowRunConfigLayer {
  if (layer.assistant !== undefined) {
    assertRegisteredProvider(layer.assistant, 'assistant');
  }
  const assistants: Record<string, Record<string, unknown>> = {};
  for (const [provider, defaults] of Object.entries(layer.assistants ?? {})) {
    assertRegisteredProvider(provider, `assistants.${provider}`);
    if (provider === 'pi' && Object.hasOwn(defaults, 'env')) {
      throw new Error(
        "Run config key 'assistants.pi.env' cannot apply: Pi extension environment mutates " +
          'process.env and is process-scoped.'
      );
    }
    if (provider === 'pi' && Object.hasOwn(defaults, 'maxConcurrent')) {
      throw new Error(
        "Run config key 'assistants.pi.maxConcurrent' cannot apply: Pi concurrency is " +
          'initialized once for the process lifetime.'
      );
    }
    try {
      assistants[provider] = getRegistration(provider).parseRunConfig(defaults);
    } catch (error) {
      if (error instanceof InvalidProviderRunConfigError) {
        const suffix = error.fieldPath ? `.${error.fieldPath}` : '';
        throw new Error(
          `Invalid run config at 'assistants.${provider}${suffix}': ${error.message}.`
        );
      }
      throw error;
    }
  }
  const tiers = Object.fromEntries(
    Object.entries(layer.tiers ?? {}).map(([tier, preset]) => [
      tier,
      normalizePreset(`tiers.${tier}`, preset),
    ])
  );
  const aliases = Object.fromEntries(
    Object.entries(layer.aliases ?? {}).map(([alias, preset]) => [
      alias,
      normalizePreset(`aliases.${alias}`, preset),
    ])
  );
  return {
    ...layer,
    ...(layer.assistants === undefined ? {} : { assistants }),
    ...(layer.tiers === undefined ? {} : { tiers }),
    ...(layer.aliases === undefined ? {} : { aliases }),
  };
}

/** Parse one explicitly selected sparse run config. Unlike shared config loading, this is fail-fast. */
export function parseWorkflowRunConfig(
  value: unknown,
  source: WorkflowRunConfigSource
): WorkflowRunConfigInput {
  if (!isRecord(value)) {
    throw new Error("Invalid run config at 'document': expected an object");
  }

  for (const key of Object.keys(value)) {
    const classification = keyClassifications[key as ConfigKey] as KeyClassification | undefined;
    if (!classification) {
      throw new Error(`Unknown run config key '${key}'.`);
    }
    if (classification.kind === 'unavailable') {
      throw new Error(`Run config key '${key}' cannot apply: ${classification.reason}.`);
    }
  }

  if (value.assistant !== undefined && value.defaultAssistant !== undefined) {
    throw new Error(
      "Run config cannot set both 'assistant' and 'defaultAssistant'; use one spelling."
    );
  }

  const docs = value.docs;
  if (docs !== undefined) {
    if (!isRecord(docs)) {
      throw new Error("Invalid run config at 'docs': expected an object");
    }
    const unknownDocsKey = Object.keys(docs).find(key => key !== 'path');
    if (unknownDocsKey) {
      throw new Error(`Unknown run config key 'docs.${unknownDocsKey}'.`);
    }
  }

  const candidate = {
    ...(value.assistant !== undefined || value.defaultAssistant !== undefined
      ? { assistant: value.assistant ?? value.defaultAssistant }
      : {}),
    ...(value.assistants !== undefined ? { assistants: value.assistants } : {}),
    ...(value.aliases !== undefined ? { aliases: value.aliases } : {}),
    ...(value.tiers !== undefined ? { tiers: value.tiers } : {}),
    ...(value.workflows !== undefined ? { workflows: value.workflows } : {}),
    ...(isRecord(docs) && docs.path !== undefined ? { docsPath: docs.path } : {}),
    ...(value.env !== undefined ? { envVars: value.env } : {}),
  };
  const parsed = workflowRunConfigLayerSchema.safeParse(candidate);
  if (!parsed.success) throw validationError(parsed.error);
  return { layer: normalizeRunConfigSemantics(parsed.data), source };
}

export async function loadWorkflowRunConfigFile(path: string): Promise<WorkflowRunConfigInput> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read run config '${path}': ${(error as Error).message}`);
  }
  let value: unknown;
  try {
    value = Bun.YAML.parse(content);
  } catch (error) {
    throw new Error(`Invalid YAML in run config '${path}': ${(error as Error).message}`);
  }
  return parseWorkflowRunConfig(value ?? {}, { kind: 'cli', label: basename(path) });
}

function serializeLayer(layer: WorkflowRunConfigLayer): string {
  return JSON.stringify(workflowRunConfigLayerSchema.parse(layer));
}

function configuredKeyPaths(layer: WorkflowRunConfigLayer): string[] {
  const paths: string[] = [];
  if (layer.assistant !== undefined) paths.push('assistant');
  for (const [provider, defaults] of Object.entries(layer.assistants ?? {})) {
    const fields = Object.keys(defaults);
    if (fields.length === 0) paths.push(`assistants.${provider}`);
    else for (const field of fields) paths.push(`assistants.${provider}.${field}`);
  }
  for (const name of Object.keys(layer.aliases ?? {})) paths.push(`aliases.${name}`);
  for (const name of Object.keys(layer.tiers ?? {})) paths.push(`tiers.${name}`);
  for (const field of Object.keys(layer.workflows ?? {})) paths.push(`workflows.${field}`);
  if (layer.docsPath !== undefined) paths.push('docs.path');
  for (const name of Object.keys(layer.envVars ?? {})) paths.push(`env.${name}`);
  return paths.sort();
}

export function sealWorkflowRunConfig(
  layer: WorkflowRunConfigLayer,
  source: WorkflowRunConfigSource
): WorkflowRunConfigMetadata {
  const plaintext = serializeLayer(layer);
  const ciphertext = encryptToken(plaintext, getEncryptionKey());
  return {
    version: 1,
    ciphertext,
    source,
    keys: configuredKeyPaths(layer),
  };
}

export function unsealWorkflowRunConfig(
  metadata: WorkflowRunConfigMetadata
): WorkflowRunConfigLayer {
  let plaintext: string;
  try {
    plaintext = decryptToken(metadata.ciphertext, getEncryptionKey());
  } catch {
    throw new Error('Workflow run config could not be decrypted.');
  }
  let value: unknown;
  try {
    value = JSON.parse(plaintext) as unknown;
  } catch {
    throw new Error('Workflow run config payload is not valid JSON.');
  }
  const parsed = workflowRunConfigLayerSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Workflow run config payload is invalid.');
  }
  return normalizeRunConfigSemantics(parsed.data);
}
