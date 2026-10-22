// Validators for config file content. Each refuses a value Archon cannot honour by
// throwing InvalidConfigError, naming the file and the key.
import { deprecatedQuotaPolicyWarning } from '@archon/workflows/schemas/run-config';
import {
  getRegistration,
  InvalidProviderRunConfigError,
  isRegisteredProvider,
} from '@archon/providers';
import {
  rawAliasesConfigSchema,
  rawTiersConfigSchema,
} from '@archon/workflows/schemas/model-binding';
import { createLogger } from '@archon/paths';
import {
  attentionNoticeRoutesSchema,
  platformStreamingSchema,
  workflowContinuationConfigSchema,
} from './config-types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('config');
  return cachedLog;
}

/**
 * A config value the validators refuse. `updateGlobalConfig` throws it before
 * writing, which is how the settings API tells a refused value (the caller's to
 * fix) from a server fault. `summary` names the refused key without the
 * server's filesystem path, so it is safe to return to a web client; `message`
 * adds the path for logs and the CLI.
 */
export class InvalidConfigError extends Error {
  readonly summary: string;

  constructor(label: string, configPath: string, detail: string) {
    super(`${label} in '${configPath}': ${detail}`);
    this.name = 'InvalidConfigError';
    this.summary = `${label}: ${detail}`;
  }
}

export function validateWorkflowContinuationConfig(parsed: unknown, configPath: string): void {
  if (typeof parsed !== 'object' || parsed === null || !('workflows' in parsed)) return;
  const config = parsed as { workflows?: unknown };
  if (config.workflows === undefined) return;
  const result = workflowContinuationConfigSchema.safeParse(config.workflows);
  if (!result.success) {
    const issues = result.error.issues
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new InvalidConfigError('Invalid workflows config', configPath, issues);
  }
  const warning = deprecatedQuotaPolicyWarning(result.data);
  if (warning !== undefined) {
    getLog().warn({ configPath, warning }, 'config.workflows_quota_keys_deprecated');
  }
  config.workflows = result.data;
}

export function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate `assistants.<provider>` through that provider's own strict parser —
 * the same one an explicitly selected `--config` run layer uses, so a value is
 * accepted or refused identically on both paths.
 *
 * A setting the provider would drop must refuse to load, because the run
 * reports it as the value the node ran at (#2582). Values are checked, not rewritten — narrowing
 * stays with the defensive parsers at the execution boundary.
 *
 * Entries for unregistered providers pass through untouched. There is no owner
 * to validate them and their current handling is to be ignored, not rejected.
 */
export function validateAssistantDefaults(parsed: unknown, configPath: string): void {
  if (!isConfigRecord(parsed)) return;
  const { assistants } = parsed;
  // A key written with nothing under it parses to null, which YAML gives no way
  // to tell from the key being absent. Both mean "no defaults here".
  if (assistants === undefined || assistants === null) return;
  const label = 'Invalid assistants config';
  if (!isConfigRecord(assistants)) {
    throw new InvalidConfigError(
      label,
      configPath,
      "'assistants' must be a map of provider settings."
    );
  }
  for (const [provider, defaults] of Object.entries(assistants)) {
    if (defaults === undefined || defaults === null) continue;
    if (!isRegisteredProvider(provider)) continue;
    validateProviderDefaults(provider, defaults, configPath);
  }
}

function validateProviderDefaults(provider: string, defaults: unknown, configPath: string): void {
  const label = 'Invalid assistants config';
  if (!isConfigRecord(defaults)) {
    throw new InvalidConfigError(label, configPath, `'assistants.${provider}' must be an object.`);
  }
  try {
    getRegistration(provider).parseConfig(defaults, 'install');
  } catch (error) {
    if (!(error instanceof InvalidProviderRunConfigError)) throw error;
    const suffix = error.fieldPath ? `.${error.fieldPath}` : '';
    throw new InvalidConfigError(
      label,
      configPath,
      `'assistants.${provider}${suffix}': ${error.message}.`
    );
  }
}

export function validateModelBindingConfig(parsed: unknown, configPath: string): void {
  if (typeof parsed !== 'object' || parsed === null) return;
  const config = parsed as Record<string, unknown>;
  for (const [field, schema] of [
    ['tiers', rawTiersConfigSchema],
    ['aliases', rawAliasesConfigSchema],
  ] as const) {
    if (config[field] === undefined) continue;
    const result = schema.safeParse(config[field]);
    if (!result.success) {
      const issues = result.error.issues
        .map(issue => `${field}.${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new InvalidConfigError('Invalid model binding config', configPath, issues);
    }
    config[field] = result.data;
  }
}

export function validateStreamingConfig(parsed: unknown, configPath: string): void {
  if (!isConfigRecord(parsed) || parsed.streaming === undefined) return;
  const result = platformStreamingSchema.safeParse(parsed.streaming);
  if (!result.success) {
    const issues = result.error.issues
      .map(issue => `streaming.${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new InvalidConfigError('Invalid streaming config', configPath, issues);
  }
  parsed.streaming = result.data;
}

export function validateAttentionNoticesConfig(parsed: unknown, configPath: string): void {
  if (!isConfigRecord(parsed) || parsed.attentionNotices === undefined) return;
  const result = attentionNoticeRoutesSchema.safeParse(parsed.attentionNotices);
  if (!result.success) {
    const issues = result.error.issues
      .map(issue => `attentionNotices.${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new InvalidConfigError('Invalid attentionNotices config', configPath, issues);
  }
  parsed.attentionNotices = result.data;
}

export function validateConversationConcurrencyConfig(parsed: unknown, configPath: string): void {
  if (!isConfigRecord(parsed) || parsed.concurrency == null) return;
  if (!isConfigRecord(parsed.concurrency)) {
    throw new InvalidConfigError(
      'Invalid concurrency config',
      configPath,
      "'concurrency' must be an object."
    );
  }
  const limit = parsed.concurrency.maxConversations;
  if (limit === undefined) return;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    throw new InvalidConfigError(
      'Invalid concurrency config',
      configPath,
      "'concurrency.maxConversations' must be a finite positive integer."
    );
  }
}

/**
 * The blocks both the global config loader and a settings write validate. Assistant
 * defaults are validated separately, after them.
 */
export function validateGlobalConfigBlocks(parsed: unknown, configPath: string): void {
  validateWorkflowContinuationConfig(parsed, configPath);
  validateModelBindingConfig(parsed, configPath);
  validateStreamingConfig(parsed, configPath);
  validateAttentionNoticesConfig(parsed, configPath);
  validateConversationConcurrencyConfig(parsed, configPath);
}
