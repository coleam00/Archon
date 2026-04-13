import { registerBuiltinProviders } from '@archon/providers';

/** Register built-in providers required by the server entrypoint. */
export function bootstrapServerProviderRegistry(): void {
  registerBuiltinProviders();
}
