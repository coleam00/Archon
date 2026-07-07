import type { QoderCliProviderDefaults } from '../../types';

export type { QoderCliProviderDefaults };

const QODER_REASONING_EFFORTS = ['low', 'medium', 'high', 'max'] as const;
const QODER_PERMISSION_MODES = [
  'default',
  'accept_edits',
  'bypass_permissions',
  'dont_ask',
  'auto',
] as const;
const QODER_SETTING_SOURCES = ['user', 'project', 'local'] as const;

type QoderReasoningEffort = (typeof QODER_REASONING_EFFORTS)[number];
type QoderPermissionMode = (typeof QODER_PERMISSION_MODES)[number];
type QoderSettingSource = (typeof QODER_SETTING_SOURCES)[number];

function isQoderReasoningEffort(value: unknown): value is QoderReasoningEffort {
  return typeof value === 'string' && QODER_REASONING_EFFORTS.includes(value as never);
}

function isQoderPermissionMode(value: unknown): value is QoderPermissionMode {
  return typeof value === 'string' && QODER_PERMISSION_MODES.includes(value as never);
}

function isQoderSettingSource(value: unknown): value is QoderSettingSource {
  return typeof value === 'string' && QODER_SETTING_SOURCES.includes(value as never);
}

function parseStringField(raw: Record<string, unknown>, field: string): string | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Invalid assistants.qodercli.${field}: expected a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid assistants.qodercli.${field}: expected a non-empty string.`);
  }
  return trimmed;
}

function describeInvalidValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'undefined') return 'undefined';
  if (typeof value === 'symbol') {
    return value.description === undefined ? 'Symbol()' : `Symbol(${value.description})`;
  }
  if (typeof value === 'function') return '[function]';
  if (value === null) return 'null';

  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function parseReasoningEffort(value: unknown): QoderReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (isQoderReasoningEffort(value)) return value;
  throw new Error(
    `Invalid assistants.qodercli.modelReasoningEffort '${describeInvalidValue(value)}'. Valid values: ${QODER_REASONING_EFFORTS.join(', ')}.`
  );
}

function parsePermissionMode(value: unknown): QoderPermissionMode | undefined {
  if (value === undefined) return undefined;
  if (isQoderPermissionMode(value)) return value;
  throw new Error(
    `Invalid assistants.qodercli.permissionMode '${describeInvalidValue(value)}'. Valid values: ${QODER_PERMISSION_MODES.join(', ')}.`
  );
}

function parseSettingSources(value: unknown): QoderSettingSource[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('Invalid assistants.qodercli.settingSources: expected an array.');
  }
  const result: QoderSettingSource[] = [];
  for (const item of value) {
    if (!isQoderSettingSource(item)) {
      throw new Error(
        `Invalid assistants.qodercli.settingSources value '${describeInvalidValue(item)}'. Valid values: ${QODER_SETTING_SOURCES.join(', ')}.`
      );
    }
    result.push(item);
  }
  return result.length > 0 ? result : undefined;
}

/**
 * Parse raw `assistants.qodercli` config into typed Qoder CLI defaults.
 * Unexpected fields are ignored, but malformed supported fields fail fast before
 * spawning the external CLI.
 */
export function parseQoderCliConfig(raw: Record<string, unknown>): QoderCliProviderDefaults {
  const config: QoderCliProviderDefaults = {};

  const model = parseStringField(raw, 'model');
  if (model) config.model = model;

  const modelReasoningEffort = parseReasoningEffort(raw.modelReasoningEffort);
  if (modelReasoningEffort) config.modelReasoningEffort = modelReasoningEffort;

  const qodercliBinaryPath = parseStringField(raw, 'qodercliBinaryPath');
  if (qodercliBinaryPath) config.qodercliBinaryPath = qodercliBinaryPath;

  const configDir = parseStringField(raw, 'configDir');
  if (configDir) config.configDir = configDir;

  const permissionMode = parsePermissionMode(raw.permissionMode);
  if (permissionMode) config.permissionMode = permissionMode;

  const outputFormat = parseStringField(raw, 'outputFormat');
  if (outputFormat) config.outputFormat = outputFormat;

  const settingSources = parseSettingSources(raw.settingSources);
  if (settingSources) {
    config.settingSources = settingSources;
  }

  const mcpConfig = parseStringField(raw, 'mcpConfig');
  if (mcpConfig) config.mcpConfig = mcpConfig;

  return config;
}
