import type { IAgentProvider } from './agent-provider';
import type { ProviderCapabilities } from './capabilities';

/** Generic per-provider defaults bag used by config surfaces and UI. */
export type ProviderDefaults = Record<string, unknown>;

/**
 * Which authored surface a strict provider-config parse is validating.
 *
 * `install` is `assistants.<provider>` in a global or repository
 * `.archon/config.yaml`; `run` is an explicitly selected per-run layer. They
 * share one parser so both paths reject the same bad values, and the scope
 * lets a provider refuse a key whose consumer owns process-lifetime state and
 * therefore cannot be re-decided per run.
 */
export type ProviderConfigScope = 'install' | 'run';

/** Strict parser for an authored provider config layer. */
export type ProviderConfigParser = (
  raw: ProviderDefaults,
  scope: ProviderConfigScope
) => ProviderDefaults;

/** Provider-keyed defaults map. Built-ins may refine individual entries. */
export type ProviderDefaultsMap = Record<string, ProviderDefaults>;

/**
 * How a credential of a given vendor can be connected / detected.
 *  - `api_key`      — a pasteable bearer string, stored encrypted per user.
 *  - `subscription` — an OAuth login (Claude Pro/Max, GitHub Copilot, ChatGPT).
 *  - `ambient`      — cloud credential chains detected from the environment
 *    (AWS for Bedrock, gcloud ADC for Vertex). Never stored, status-only.
 *
 * Exported as a const tuple so API schemas can derive `z.enum(CREDENTIAL_KINDS)`
 * instead of re-listing the literals.
 */
export const CREDENTIAL_KINDS = ['api_key', 'subscription', 'ambient'] as const;

export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/**
 * One upstream-vendor credential an agent provider can consume. `vendor` is the
 * canonical credential id (e.g. 'anthropic', 'openrouter', 'github-copilot') —
 * deliberately NOT the agent provider id: one credential can serve multiple
 * agents (an 'anthropic' key powers Claude Code, Pi's anthropic backend, and
 * OpenCode). Delivery (vendor → env vars / files) is owned by
 * @archon/core/credentials — this spec is only the consumption matrix.
 */
export interface CredentialSpec {
  /** Canonical vendor id — used as the storage key in user_provider_keys. */
  vendor: string;
  /** Human-readable vendor name for UI display (e.g. 'OpenRouter'). */
  displayName: string;
  /** Which connection kinds this vendor supports for this agent (at least one). */
  kinds: [CredentialKind, ...CredentialKind[]];
}

/**
 * An agent's credential catalog. `static` lists the vendors up front
 * (Claude/Codex/Copilot/Pi); `dynamic` means the set is only knowable at
 * runtime (OpenCode resolves its models.dev catalog via the embedded server's
 * introspection API and exposes it through a dedicated endpoint).
 */
export type ProviderCredentialCatalog =
  | {
      kind: 'static';
      specs: CredentialSpec[];
      vendorFor(model: string | undefined): string | undefined;
    }
  | { kind: 'dynamic'; vendorFor(model: string | undefined): undefined };

/**
 * Registration entry for a provider in the provider registry.
 * Each entry carries metadata, a factory, and model-compatibility logic.
 * The registry is the source of truth for provider identity, capabilities, and display.
 */
export interface ProviderRegistration {
  /** Unique provider identifier — used in YAML, config, DB */
  id: string;

  /** Human-readable name for UI display */
  displayName: string;

  /** Instantiate a provider */
  factory: () => IAgentProvider;

  /** Static capability declaration — used for dag-executor warnings */
  capabilities: ProviderCapabilities;

  /** Whether this is a built-in (maintained by core team) or community provider */
  builtIn: boolean;

  /**
   * Credentials this agent can consume. Required: registering an agent without
   * declaring its credential surface is a bug, not a default (#1955) — the
   * connectable-vendor catalog and the agent→credential matrix in
   * GET /api/auth/providers are derived from these declarations.
   */
  credentials: ProviderCredentialCatalog;

  /**
   * Validate and normalize authored provider defaults, for `.archon/config.yaml`
   * and for a per-run config layer alike. Execution-time parsing stays defensive
   * and tolerant; an authored setting must reject values the provider would
   * otherwise silently discard.
   */
  parseConfig: ProviderConfigParser;
}

/**
 * Standardized error for unknown provider types.
 * Thrown by getAgentProvider() — all surfaces (CLI, server, orchestrator, workflows)
 * get the same error shape and message format.
 */
export class UnknownProviderError extends Error {
  constructor(
    public readonly requestedProvider: string,
    public readonly registeredProviders: string[]
  ) {
    super(`Unknown provider: '${requestedProvider}'. Available: ${registeredProviders.join(', ')}`);
    this.name = 'UnknownProviderError';
  }
}

/** A provider-owned strict run-config parser rejected one field. */
export class InvalidProviderRunConfigError extends Error {
  constructor(
    public readonly fieldPath: string,
    message: string
  ) {
    super(message);
    this.name = 'InvalidProviderRunConfigError';
  }
}
