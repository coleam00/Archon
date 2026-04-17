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
}

/**
 * Build a Pi ResourceLoader that performs no filesystem discovery. Archon is
 * the source of truth for extensions, skills, prompts, themes, and context
 * files — Pi should not walk cwd or read ~/.pi/agent/ during server-side
 * workflow execution.
 *
 * Implementation note: we delegate to `DefaultResourceLoader` with all
 * `no*` flags set, rather than implementing `ResourceLoader` ourselves. The
 * interface's `getExtensions()` returns a `LoadExtensionsResult` requiring a
 * real `ExtensionRuntime`, which we can't meaningfully stub. DefaultResourceLoader
 * honors the flags and returns empty-but-valid results.
 *
 * A caller-supplied `systemPrompt` is still applied (it's set on the loader
 * directly, not via filesystem discovery).
 */
export function createNoopResourceLoader(
  cwd: string,
  options: NoopResourceLoaderOptions = {}
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    noExtensions: true,
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
