import { registerBuiltinProviders } from '@archon/providers';

/** Register built-in providers required by the CLI entrypoint. */
export function bootstrapCliProviderRegistry(): void {
  registerBuiltinProviders();
}
