import { DefaultResourceLoader } from '@mariozechner/pi-coding-agent';

export interface NoopResourceLoaderOptions {
  /**
   * Override Pi's system prompt entirely. When omitted, Pi uses its default.
   * Forwarded to `DefaultResourceLoader({ systemPrompt })` — the no* flags
   * below still suppress all discovery of `AGENTS.md` / `CLAUDE.md` context
   * files that would otherwise augment or replace the prompt.
   */
  systemPrompt?: string;

  /**
   * Absolute paths to specific skill directories (each containing a SKILL.md)
   * that Pi should load in addition to its default discovery. Works even with
   * `noSkills: true` — Pi's loader merges additional paths regardless, per
   * its internal logic in `DefaultResourceLoader.updateSkillsFromPaths`.
   *
   * Used by the Pi provider to thread Archon's name-based `skills:` node
   * config through to Pi after resolution — see `resolvePiSkills`.
   */
  additionalSkillPaths?: string[];

  /**
   * Opt-in to Pi's extension discovery. When true, `noExtensions` flips to
   * false and Pi loads:
   *   - `~/.pi/agent/extensions/*.ts` (global, operator-installed)
   *   - packages listed in `~/.pi/agent/settings.json` (from `pi install`)
   *   - `<cwd>/.pi/extensions/*.ts` (project-local — REPO-CONTROLLED, risky)
   *   - packages listed in `<cwd>/.pi/settings.json`
   *
   * This is the switch that opens up the community package ecosystem
   * (https://shittycodingagent.ai/packages) — ~540 npm packages registering
   * custom tools and lifecycle hooks via `pi.registerTool()` / `pi.on()`.
   * Tools and hooks work fully in programmatic sessions; TUI-only features
   * (renderers, keybindings, slash commands) silently no-op. Extensions that
   * gate on `ctx.hasUI` additionally need `interactive: true` — see
   * `PiProviderDefaults.interactive`.
   *
   * Trust boundary: enabling this loads arbitrary JS code with the Archon
   * server's OS permissions. Only flip this on when the operator trusts both
   * globally-installed extensions AND whatever `.pi/` the workflow's target
   * repo happens to contain.
   *
   * @default false
   */
  enableExtensions?: boolean;
}

/**
 * Build a Pi ResourceLoader. By default performs no filesystem discovery —
 * Archon is the source of truth for skills, prompts, themes, and context
 * files, and Pi should not walk cwd or read `~/.pi/agent/` during server-side
 * workflow execution. When `enableExtensions: true`, the `noExtensions` gate
 * is lifted so Pi discovers and loads tools + hooks from the community
 * ecosystem (see `NoopResourceLoaderOptions.enableExtensions`). Skills and
 * prompts/themes remain suppressed even when extensions are enabled — skills
 * are still driven by Archon's explicit `additionalSkillPaths` plumbing.
 *
 * Implementation note: we delegate to `DefaultResourceLoader` with the
 * relevant `no*` flags set, rather than implementing `ResourceLoader`
 * ourselves. The interface's `getExtensions()` returns a `LoadExtensionsResult`
 * requiring a real `ExtensionRuntime`, which we can't meaningfully stub.
 * DefaultResourceLoader honors the flags and returns empty-but-valid results.
 */
export function createNoopResourceLoader(
  cwd: string,
  options: NoopResourceLoaderOptions = {}
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    noExtensions: options.enableExtensions !== true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.additionalSkillPaths && options.additionalSkillPaths.length > 0
      ? { additionalSkillPaths: options.additionalSkillPaths }
      : {}),
  });
}
