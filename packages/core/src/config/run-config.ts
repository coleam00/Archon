import { createLogger } from '@archon/paths';
import { missingProviderMessage, type ProviderDefaults } from '@archon/provider-contract';
import { providerRegistry } from '@archon/providers';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
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
  deprecatedQuotaPolicyWarning,
  workflowRunConfigLayerSchema,
  type WorkflowRunConfigInput,
  type WorkflowRunConfigLayer,
  type WorkflowRunConfigMetadata,
  type WorkflowRunConfigSource,
} from '@archon/workflows/schemas/run-config';
import { readWorkflowRunConfigMetadata } from '@archon/workflows/run-config';
import { encryptToken, getEncryptionKey } from '../utils/token-crypto';
import type { GlobalConfig, RepoConfig } from './config-types';
import { unsealWorkflowRunConfigStructure } from './run-config-handoff';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('config.run');
  return cachedLog;
}

type ConfigKey = keyof GlobalConfig | keyof RepoConfig;
type KeyClassification = { kind: 'runtime' } | { kind: 'unavailable'; reason: string };

const keyClassifications = {
  store: { kind: 'unavailable', reason: 'persistence is selected at install startup' },
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
  attentionNotices: {
    kind: 'unavailable',
    reason: 'attention notice routes are install-scoped and have no per-run consumer',
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

export const workflowRunConfigKeys = Object.entries(keyClassifications)
  .filter(([, classification]) => classification.kind === 'runtime')
  .map(([key]) => key);

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
  throw new Error(
    `Invalid run config at '${path}': ${missingProviderMessage(providerRegistry, provider)}`
  );
}

function normalizePreset(path: string, preset: ModelAliasPreset): ModelAliasPreset {
  try {
    return normalizeStrictRunModelPreset(providerRegistry, preset);
  } catch (error) {
    if (!(error instanceof RunModelPresetValidationError)) throw error;
    const issuePath = `${path}.${error.issue.field}`;
    throw new Error(`Invalid run config at '${issuePath}': ${error.message}.`);
  }
}

function parseAssistantDefaults(
  provider: string,
  defaults: ProviderDefaults
): Record<string, unknown> {
  assertRegisteredProvider(provider, `assistants.${provider}`);
  try {
    return getRegistration(provider).parseConfig(defaults, 'run');
  } catch (error) {
    if (!(error instanceof InvalidProviderRunConfigError)) throw error;
    const suffix = error.fieldPath ? `.${error.fieldPath}` : '';
    throw new Error(`Invalid run config at 'assistants.${provider}${suffix}': ${error.message}.`);
  }
}

function normalizeAssistants(
  assistants: NonNullable<WorkflowRunConfigLayer['assistants']>
): Record<string, Record<string, unknown>> {
  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [provider, defaults] of Object.entries(assistants)) {
    normalized[provider] = parseAssistantDefaults(provider, defaults);
  }
  return normalized;
}

function normalizePresets(
  section: 'tiers' | 'aliases',
  presets: Record<string, ModelAliasPreset>
): Record<string, ModelAliasPreset> {
  return Object.fromEntries(
    Object.entries(presets).map(([name, preset]) => [
      name,
      normalizePreset(`${section}.${name}`, preset),
    ])
  );
}

/** Validate and normalize constraints owned by the live provider registry and lifecycle. */
export function normalizeRunConfigSemantics(layer: WorkflowRunConfigLayer): WorkflowRunConfigLayer {
  if (layer.assistant !== undefined) {
    assertRegisteredProvider(layer.assistant, 'assistant');
  }
  return {
    ...layer,
    ...(layer.assistants === undefined
      ? {}
      : { assistants: normalizeAssistants(layer.assistants) }),
    ...(layer.tiers === undefined ? {} : { tiers: normalizePresets('tiers', layer.tiers) }),
    ...(layer.aliases === undefined ? {} : { aliases: normalizePresets('aliases', layer.aliases) }),
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

  assertRunConfigKeys(value);
  const docs = value.docs;
  assertRunConfigDocs(docs);
  const candidate = runConfigCandidate(value, docs);
  const parsed = workflowRunConfigLayerSchema.safeParse(candidate);
  if (!parsed.success) throw validationError(parsed.error);
  const warning = parsed.data.workflows && deprecatedQuotaPolicyWarning(parsed.data.workflows);
  if (warning) getLog().warn({ source: source.label, warning }, 'run_config.quota_keys_deprecated');
  return { layer: normalizeRunConfigSemantics(parsed.data), source };
}

function assertRunConfigKeys(value: Record<string, unknown>): void {
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
}

function assertRunConfigDocs(docs: unknown): asserts docs is Record<string, unknown> | undefined {
  if (docs !== undefined) {
    if (!isRecord(docs)) {
      throw new Error("Invalid run config at 'docs': expected an object");
    }
    const unknownDocsKey = Object.keys(docs).find(key => key !== 'path');
    if (unknownDocsKey) {
      throw new Error(`Unknown run config key 'docs.${unknownDocsKey}'.`);
    }
  }
}

function runConfigCandidate(
  value: Record<string, unknown>,
  docs: Record<string, unknown> | undefined
) {
  return {
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
  paths.push(...assistantKeyPaths(layer.assistants ?? {}));
  for (const name of Object.keys(layer.aliases ?? {})) paths.push(`aliases.${name}`);
  for (const name of Object.keys(layer.tiers ?? {})) paths.push(`tiers.${name}`);
  for (const field of Object.keys(layer.workflows ?? {})) paths.push(`workflows.${field}`);
  if (layer.docsPath !== undefined) paths.push('docs.path');
  for (const name of Object.keys(layer.envVars ?? {})) paths.push(`env.${name}`);
  return paths.sort();
}

function assistantKeyPaths(
  assistants: NonNullable<WorkflowRunConfigLayer['assistants']>
): string[] {
  const paths: string[] = [];
  for (const [provider, defaults] of Object.entries(assistants)) {
    const fields = Object.keys(defaults);
    if (fields.length === 0) paths.push(`assistants.${provider}`);
    else for (const field of fields) paths.push(`assistants.${provider}.${field}`);
  }
  return paths;
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
  return normalizeRunConfigSemantics(unsealWorkflowRunConfigStructure(metadata));
}

/**
 * The run config another run was started with, for `--config-from-run`. A run started
 * without one returns undefined: it ran on the install's config alone, so the new launch
 * does too. The source label names the run it came from.
 */
export function workflowRunConfigFromRun(run: {
  id: string;
  metadata?: Record<string, unknown>;
}): WorkflowRunConfigInput | undefined {
  const sealed = readWorkflowRunConfigMetadata(run.metadata);
  if (!sealed) return undefined;
  return {
    layer: unsealWorkflowRunConfig(sealed),
    source: { kind: sealed.source.kind, label: `run ${run.id} (${sealed.source.label})` },
  };
}
