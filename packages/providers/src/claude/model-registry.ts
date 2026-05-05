/**
 * Custom model registry for Claude provider.
 *
 * Similar to Pi's ~/.pi/agent/models.json, allows users to define custom
 * providers with their own base URLs, credentials, and model catalogs in
 * `~/.archon/claude-models.json`. Workflows reference models by friendly
 * name and the registry resolves to the actual model ID + injects the
 * appropriate Claude Code provider env vars.
 *
 * File format (mirrors Pi's providers structure):
 * ```json
 * {
 *   "providers": {
 *     "my-provider": {
 *       "baseUrl": "https://api.example.com",
 *       "apiKey": "MY_PROVIDER_API_KEY",
 *       "authToken": "MY_PROVIDER_AUTH_TOKEN",
 *       "headers": { "X-Custom": "MY_PROVIDER_HEADER_VALUE" },
 *       "models": [
 *         { "id": "vendor/model-name", "name": "friendly-alias" }
 *       ]
 *     }
 *   }
 * }
 * ```
 *
 * Credential and header values may be either environment variable names or
 * literal values. If an env var with the configured name exists, its value is
 * used; otherwise the configured value is passed through unchanged.
 *
 * Resolution: workflow uses `model: "friendly-alias"` → registry finds the
 * model entry, returns the real `id` plus provider env overrides.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getArchonHome } from '@archon/paths';

export interface ClaudeCustomModel {
  /** Actual model ID passed to the Claude SDK (format: "vendor/model-name") */
  id: string;
  /** Friendly name used in workflows */
  name: string;
  /** Whether the model supports extended thinking/reasoning (same as Pi agent's models.json) */
  reasoning?: boolean;
}

export interface ClaudeCustomProvider {
  baseUrl: string;
  apiKey?: string;
  authToken?: string;
  headers?: Record<string, string>;
  models: ClaudeCustomModel[];
}

export interface ClaudeModelsConfig {
  providers: Record<string, ClaudeCustomProvider>;
}

export interface ResolvedModel {
  /** The model ID to pass to the SDK */
  resolvedId: string;
  /** How the model was matched */
  matchedBy: 'name' | 'id' | 'passthrough';
  /** Provider name (undefined for passthrough) */
  providerName?: string;
  /** Env vars to inject into the Claude subprocess (baseUrl, credentials, headers) */
  env?: Record<string, string>;
  /** Custom headers encoded into ANTHROPIC_CUSTOM_HEADERS */
  headers?: Record<string, string>;
}

const MODELS_FILENAME = 'claude-models.json';

/**
 * Return true only for strings that contain visible non-whitespace content.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Return true when a header name can be serialized into ANTHROPIC_CUSTOM_HEADERS.
 */
function isValidHeaderName(name: string): boolean {
  return name.length > 0 && !/[:\r\n]/.test(name);
}

/**
 * Return true when a header value can be serialized into ANTHROPIC_CUSTOM_HEADERS.
 */
function isValidHeaderValue(value: string): boolean {
  return !/[\r\n]/.test(value);
}

/**
 * Resolve Pi-style config values: env var name first, literal fallback.
 */
function resolveConfigValue(value: string): string {
  const envName = value.startsWith('$') ? value.slice(1) : value;
  if (envName.length > 0) {
    const envValue = process.env[envName];
    if (isNonEmptyString(envValue)) return envValue;
  }
  return value;
}

/**
 * Resolve custom header values and keep only values safe for env serialization.
 */
function resolveHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;

  const resolvedHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const resolvedValue = resolveConfigValue(value);
    if (!isValidHeaderValue(resolvedValue)) continue;
    resolvedHeaders[name] = resolvedValue;
  }

  return Object.keys(resolvedHeaders).length > 0 ? resolvedHeaders : undefined;
}

export class ClaudeModelRegistry {
  private providers: Record<string, ClaudeCustomProvider> = {};
  private loadError: string | undefined;

  /**
   * Create a registry and eagerly load `~/.archon/claude-models.json`.
   */
  constructor() {
    this.load();
  }

  /**
   * Load, validate, and normalize custom Claude provider definitions from disk.
   */
  private load(): void {
    const filePath = join(getArchonHome(), MODELS_FILENAME);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        this.providers = {};
        return;
      }
      this.loadError = `Failed to read ${filePath}: ${e.message}`;
      this.providers = {};
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      this.loadError = `Invalid JSON in ${filePath}: ${(parseErr as SyntaxError).message}`;
      this.providers = {};
      return;
    }

    const providers =
      parsed && typeof parsed === 'object' && 'providers' in parsed
        ? (parsed as ClaudeModelsConfig).providers
        : undefined;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
      this.loadError = `${filePath} must have a "providers" object`;
      this.providers = {};
      return;
    }

    this.providers = {};
    const validationMessages: string[] = [];

    for (const [name, provider] of Object.entries(providers)) {
      if (!provider || typeof provider !== 'object') continue;
      if (!isNonEmptyString(provider.baseUrl)) {
        validationMessages.push(`Provider "${name}" skipped: baseUrl must be a non-empty string`);
        continue;
      }
      if (!isNonEmptyString(provider.apiKey) && !isNonEmptyString(provider.authToken)) {
        validationMessages.push(
          `Provider "${name}" skipped: apiKey or authToken must be a non-empty string`
        );
        continue;
      }
      if (!Array.isArray(provider.models)) continue;

      const validModels = provider.models.filter(
        (m): m is ClaudeCustomModel =>
          typeof m === 'object' && m !== null && isNonEmptyString(m.id) && isNonEmptyString(m.name)
      );

      const validHeaders: Record<string, string> = {};
      if (provider.headers && typeof provider.headers === 'object') {
        for (const [headerName, headerValue] of Object.entries(provider.headers)) {
          if (typeof headerValue !== 'string') continue;
          if (!isValidHeaderName(headerName)) {
            validationMessages.push(
              `Provider "${name}" header "${headerName}" skipped: names cannot contain colon or newlines`
            );
            continue;
          }
          if (!isValidHeaderValue(headerValue)) {
            validationMessages.push(
              `Provider "${name}" header "${headerName}" skipped: values cannot contain newlines`
            );
            continue;
          }
          validHeaders[headerName] = headerValue;
        }
      }
      const headers = Object.keys(validHeaders).length > 0 ? validHeaders : undefined;

      this.providers[name] = {
        baseUrl: provider.baseUrl,
        ...(isNonEmptyString(provider.apiKey) ? { apiKey: provider.apiKey } : {}),
        ...(isNonEmptyString(provider.authToken) ? { authToken: provider.authToken } : {}),
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
        models: validModels,
      };
    }

    if (validationMessages.length > 0) {
      this.loadError = `Invalid entries in ${filePath}: ${validationMessages.join('; ')}`;
    }
  }

  /**
   * Resolve a model reference to its actual ID and provider configuration.
   *
   * Resolution order:
   *   1. Provider-scoped lookup: if input is "providerName/modelRef", search
   *      within that specific provider by name or id
   *   2. Exact model `id` match across all providers
   *   3. Case-insensitive `name` match across all providers
   *   4. Case-insensitive `id` match across all providers
   *   5. Pass-through (return input unchanged, no env overrides)
   */
  resolve(modelRef: string): ResolvedModel {
    // 1. Provider-scoped: "providerName/modelRef" format
    const slashIdx = modelRef.indexOf('/');
    if (slashIdx > 0) {
      const prefix = modelRef.slice(0, slashIdx);
      const remainder = modelRef.slice(slashIdx + 1);
      const provider = this.providers[prefix];
      if (provider && remainder.length > 0) {
        const remainderLower = remainder.toLowerCase();
        const byName = provider.models.find(m => m.name.toLowerCase() === remainderLower);
        if (byName) {
          return this.buildResult(byName.id, 'name', prefix, provider);
        }
        const byId = provider.models.find(m => m.id.toLowerCase() === remainderLower);
        if (byId) {
          return this.buildResult(byId.id, 'id', prefix, provider);
        }
      }
    }

    const searchLower = modelRef.toLowerCase();

    // 2. Exact id match
    for (const [providerName, provider] of Object.entries(this.providers)) {
      const exactId = provider.models.find(m => m.id === modelRef);
      if (exactId) {
        return this.buildResult(exactId.id, 'id', providerName, provider);
      }
    }

    // 3. Case-insensitive name match
    for (const [providerName, provider] of Object.entries(this.providers)) {
      const byName = provider.models.find(m => m.name.toLowerCase() === searchLower);
      if (byName) {
        return this.buildResult(byName.id, 'name', providerName, provider);
      }
    }

    // 4. Case-insensitive id match
    for (const [providerName, provider] of Object.entries(this.providers)) {
      const byId = provider.models.find(m => m.id.toLowerCase() === searchLower);
      if (byId) {
        return this.buildResult(byId.id, 'id', providerName, provider);
      }
    }

    // 5. Pass-through
    return { resolvedId: modelRef, matchedBy: 'passthrough' };
  }

  /**
   * Build the resolved model payload consumed by the Claude provider.
   */
  private buildResult(
    resolvedId: string,
    matchedBy: 'name' | 'id',
    providerName: string,
    provider: ClaudeCustomProvider
  ): ResolvedModel {
    const headers = resolveHeaders(provider.headers);
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: resolveConfigValue(provider.baseUrl),
    };
    if (provider.apiKey) env.ANTHROPIC_API_KEY = resolveConfigValue(provider.apiKey);
    if (provider.authToken) env.ANTHROPIC_AUTH_TOKEN = resolveConfigValue(provider.authToken);
    if (headers) {
      env.ANTHROPIC_CUSTOM_HEADERS = Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join('\n');
    }
    return {
      resolvedId,
      matchedBy,
      providerName,
      env,
      ...(headers ? { headers } : {}),
    };
  }

  /**
   * Return every custom model loaded from every valid configured provider.
   */
  getAll(): { providerName: string; model: ClaudeCustomModel }[] {
    const result: { providerName: string; model: ClaudeCustomModel }[] = [];
    for (const [providerName, provider] of Object.entries(this.providers)) {
      for (const model of provider.models) {
        result.push({ providerName, model });
      }
    }
    return result;
  }

  /**
   * Return the last registry load error, if reading or parsing the config failed.
   */
  getError(): string | undefined {
    return this.loadError;
  }
}
