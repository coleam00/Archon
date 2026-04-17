import type { ProviderCapabilities } from '../../types';

/**
 * Pi capabilities — intentionally conservative. Declared flags must reflect
 * wired-up behavior, not potential support. The dag-executor uses these to
 * warn users when a workflow node specifies a feature the provider ignores.
 *
 * Roadmap (v3+): 
 * The pi maintainer has expressed some opposition to supporting structured
 * output, (https://github.com/badlogic/pi-mono/issues/1086) so that is 
 * unlikely to be added apart from an extension.
 *
 * Similarly, hooks, fallbackModel, and sandbox can be implemented with
 * extensions, but probably not off-the-shelf pi.
 */
export const PI_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: false,
  hooks: false,
  skills: true,
  toolRestrictions: true,
  structuredOutput: false,
  envInjection: true,
  costControl: false,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: false,
  sandbox: false,
};
