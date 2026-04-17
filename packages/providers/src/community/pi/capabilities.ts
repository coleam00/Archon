import type { ProviderCapabilities } from '../../types';

/**
 * Pi v1 capabilities — intentionally conservative. Declared flags must reflect
 * wired-up behavior, not potential support. The dag-executor uses these to
 * warn users when a workflow node specifies a feature the provider ignores.
 *
 * Roadmap (v2+): thinkingControl, skills, envInjection can be flipped once
 * the corresponding nodeConfig fields are intentionally translated to Pi's
 * runtime options.
 */
export const PI_CAPABILITIES: ProviderCapabilities = {
  sessionResume: false,
  mcp: false,
  hooks: false,
  skills: false,
  toolRestrictions: true,
  structuredOutput: false,
  envInjection: false,
  costControl: false,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: false,
  sandbox: false,
};
