/**
 * User-facing hints for OMP ModelRegistry resolution failures.
 *
 * OMP stores custom providers in ~/.omp/agent/models.yml (models.json is legacy),
 * runtime discovery caches in ~/.omp/agent/models.db, and credentials in agent.db.
 */

/** Providers whose model catalogs come from runtime discovery, not models.yml. */
export const OMP_RUNTIME_DISCOVERED_PROVIDERS = new Set([
  'cursor',
  'github-copilot',
  'ollama',
  'openai-codex',
]);

export function isOmpRuntimeDiscoveredProvider(providerId: string): boolean {
  return OMP_RUNTIME_DISCOVERED_PROVIDERS.has(providerId);
}

export function formatOmpModelConfigLoadHint(loadError: string | undefined): string {
  if (!loadError) return '';
  return ` ~/.omp/agent/models.yml failed to load: ${loadError}`;
}

export function formatOmpModelRequiredMessage(): string {
  return (
    'OMP provider requires a model. Set `model` on the workflow (or node), optionally `assistants.omp.model` in .archon/config.yaml, ' +
    'or `modelRoles.default` in ~/.omp/agent/config.yml. ' +
    "Format: '<provider-id>/<model-id>' (e.g. 'cursor/composer-2.5', 'minimax-token-plan/MiniMax-M3')."
  );
}

export function formatOmpInvalidModelRefMessage(modelRef: string): string {
  return (
    `Invalid OMP model ref: '${modelRef}'. Expected format '<provider-id>/<model-id>' ` +
    "(e.g. 'cursor/composer-2.5'). Provider ids use lowercase letters, digits, and hyphens only."
  );
}

export function formatOmpAuthInitFailedMessage(message: string): string {
  return (
    `OMP auth storage init failed: ${message}. ` +
    'Check that ~/.omp/agent/agent.db is readable (run `omp /login` to authenticate) ' +
    'or set provider API keys via assistants.omp.env in .archon/config.yaml.'
  );
}

export function formatOmpModelNotFoundMessage(
  provider: string,
  modelId: string,
  loadError?: string
): string {
  const configHint = formatOmpModelConfigLoadHint(loadError);
  const parts = [
    `OMP model not found: provider='${provider}' model='${modelId}'.${configHint}`,
    'Custom providers and overrides live in ~/.omp/agent/models.yml (models.json is legacy and only used when YAML is absent).',
    'Runtime-discovered providers (Cursor, GitHub Copilot, Ollama, Codex) cache catalogs in ~/.omp/agent/models.db.',
    'Credentials are stored in ~/.omp/agent/agent.db via `omp /login` or workflow env vars.',
  ];

  if (isOmpRuntimeDiscoveredProvider(provider)) {
    parts.push(
      `Provider '${provider}' is discovery-based: run \`omp\` interactively or \`omp models\` to refresh the catalog, then reference an id from that list.`
    );
  } else {
    parts.push(`Ensure '${provider}/${modelId}' exists in models.yml or the built-in catalog.`);
  }

  return parts.join(' ');
}
