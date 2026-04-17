import { DefaultResourceLoader } from '@mariozechner/pi-coding-agent';

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
 */
export function createNoopResourceLoader(cwd: string): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
}
