/**
 * Registry-driven model validation.
 *
 * All provider/model compatibility checks delegate to ProviderRegistration entries
 * in the provider registry. No hardcoded provider knowledge lives here.
 */
import { getRegistration, getRegisteredProviders, isRegisteredProvider } from '@archon/providers';

/**
 * Infer provider from a model name by iterating BUILT-IN registrations only.
 * Community providers must be selected explicitly via `provider:` in YAML.
 *
 * Returns undefined if no built-in provider matches (caller falls back to config default).
 */
export function inferProviderFromModel(model: string | undefined, defaultProvider: string): string {
  if (!model) return defaultProvider;

  for (const reg of getRegisteredProviders()) {
    if (reg.builtIn && reg.isModelCompatible(model)) return reg.id;
  }

  // No built-in matched — fall back to default
  return defaultProvider;
}

/**
 * Check if a model is compatible with a provider using the registry.
 * Returns true if no model is specified (any provider accepts no-model).
 * Throws on unknown providers (fail-fast — matches getProviderCapabilities behavior).
 */
export function isModelCompatible(provider: string, model?: string): boolean {
  if (!model) return true;
  if (!isRegisteredProvider(provider)) {
    throw new Error(
      `Unknown provider '${provider}'. Registered providers: ${getRegisteredProviders()
        .map(p => p.id)
        .join(', ')}`
    );
  }
  return getRegistration(provider).isModelCompatible(model);
}
