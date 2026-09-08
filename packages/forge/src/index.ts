/**
 * `@archon/forge` , the engine's forge contract (design #3040).
 *
 * A leaf package: `zod` and `@archon/paths` only, so a plugin author's
 * conformance kit and the engine SDK can both depend on it without pulling
 * in `@archon/providers` or the rest of the engine (direction.md
 * §standalone-core).
 */
export * from './schemas';
export { ForgeDispatcher, DuplicateHostClaimError, parseRemoteUrl } from './dispatch/dispatcher';
export type {
  ForgeDispatchResult,
  ForgeDispatchOk,
  ForgeDispatchErr,
  DispatcherOptions,
} from './dispatch/dispatcher';
export { createGitHubPlugin, GITHUB_HOST } from './github/plugin';
export type { GitHubPluginOptions } from './github/plugin';
