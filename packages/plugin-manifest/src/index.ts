/**
 * The shared distribution contract for Archon plugins: the author-owned
 * `archon-plugin.json` manifest and the local install receipt.
 *
 * Schema only. The CLI installer, workflow discovery and the docs-site index all
 * parse these shapes, and none of those packages can import another, so the
 * schemas live in this leaf package with no dependency beyond zod.
 */
import { z } from 'zod';

export const PLUGIN_MANIFEST_FILE = 'archon-plugin.json';

const pluginName = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase words joined by "-"');

/** The file name forge discovery scans for, without the Windows `.exe` suffix. */
const forgeExecutable = z
  .string()
  .regex(/^archon-forge-[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be archon-forge-<name>');

// A kind joins this schema when its install path and runtime contract exist.
// Until then its manifest is rejected, rather than accepted and half-installed.
export const pluginManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('forge'),
    name: pluginName,
    description: z.string().min(1),
    // A semver range checked against the running Archon at install time.
    compatibility: z
      .object({ archon: z.string().min(1) })
      .strict()
      .optional(),
    executable: forgeExecutable,
  })
  .strict();

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * One file the install wrote, relative to the plugins directory. A single path
 * segment: `remove` deletes exactly these names, so a receipt must not be able
 * to name anything outside that directory.
 */
const installedFile = z
  .object({
    path: z
      .string()
      .regex(/^[^/\\]+$/)
      .refine(path => path !== '.' && path !== '..', 'must name a file'),
    sha256,
  })
  .strict();

export const pluginReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** `owner/repo[/path]`, the location of the manifest. */
    id: z.string().min(1),
    manifest: pluginManifestSchema,
    /** The release tag the files came from. */
    tag: z.string().min(1),
    /** The commit that tag resolved to at install time. */
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    installedAt: z.iso.datetime(),
    files: z.array(installedFile).min(1),
  })
  .strict();

export type PluginReceipt = z.infer<typeof pluginReceiptSchema>;
