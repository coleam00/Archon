import type { ProviderCapabilities } from '../../types';

/**
 * Starting point for a community provider's `capabilities.ts`.
 *
 * Typed as `ProviderCapabilities` so a capability the interface requires cannot go
 * missing from the template a contributor copies.
 */
export const YOUR_CAPABILITIES: ProviderCapabilities = {
  sessionResume: false,
  mcp: false,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: false,
  structuredOutput: false,
  envInjection: false,
  costControl: false,
  effortControl: false,
  fallbackModel: false,
  sandbox: false,
  settingSources: false,
  nativeTools: false,
  containerExec: false,
};

/** The axes `ProviderCapabilities` marks optional. */
type OptionalCapabilityAxis = {
  [K in keyof ProviderCapabilities]-?: undefined extends ProviderCapabilities[K] ? K : never;
}[keyof ProviderCapabilities];

/**
 * The optional axes, named so the guide shows them too. This is a checklist, not
 * configuration: an optional axis you support goes in `YOUR_CAPABILITIES` above. A new
 * optional axis in `ProviderCapabilities` fails type-check until it is listed here.
 */
export const OPTIONAL_AXES = {
  sessionFork: true,
  knownToolNames: true,
  renamedTools: true,
} satisfies Record<OptionalCapabilityAxis, true>;
