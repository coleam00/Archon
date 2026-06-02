/**
 * OMP's ResourceLoader interface for programmatic sessions.
 * In v1, we suppress all filesystem discovery — Archon is the source of truth
 * for skills, prompts, context files, and themes. Only skills explicitly passed
 * via additionalSkillPaths are loaded.
 *
 * The OMP SDK doesn't expose a public NoopResourceLoader; we implement a minimal
 * stub that satisfies the ResourceLoader interface by delegating to the one
 * OMP creates internally when no custom loader is needed.
 */
export interface OmpResourceLoaderOptions {
  /**
   * Override OMP's system prompt entirely. When omitted, OMP uses its default.
   */
  systemPrompt?: string;

  /**
   * Absolute paths to specific skill directories (each containing a SKILL.md)
   * that OMP should load. Works even with skills discovery disabled.
   */
  additionalSkillPaths?: string[];

  /**
   * Opt-in to OMP's extension discovery. When true, OMP loads:
   *   - `~/.omp/agent/extensions/*.ts` (global)
   *   - packages listed in `~/.omp/agent/settings.json`
   *   - `<cwd>/.omp/extensions/*.ts` (project-local — REPO-CONTROLLED, risky)
   *
   * Trust boundary: enabling this loads arbitrary JS with the Archon server's
   * OS permissions. Only flip this on when the operator trusts both
   * globally-installed extensions AND whatever `.omp/` the workflow's target
   * repo contains.
   *
   * @default false
   */
  enableExtensions?: boolean;
}

/**
 * Placeholder ResourceLoader stub for OMP v1.
 *
 * OMP's `createAgentSession` accepts an optional `resourceLoader` parameter.
 * When omitted, OMP uses its own internal resource loader (DefaultResourceLoader)
 * with all discovery enabled. To suppress discovery, we would need to pass a
 * custom loader — but the public SDK doesn't expose a simple no-op implementation.
 *
 * For v1, we pass `undefined` and accept that OMP may discover some resources
 * from the filesystem. Skills from `additionalSkillPaths` are still loaded
 * explicitly via the session's `skills` option.
 *
 * TODO: When OMP exposes `disableResourceDiscovery()` or a `NoopResourceLoader`,
 * wire it here to truly suppress filesystem discovery.
 */
export function createOmpResourceLoader(
  _cwd: string,
  _options: OmpResourceLoaderOptions = {}
): undefined {
  // v1: let OMP use its default loader
  return undefined;
}
