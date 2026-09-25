/**
 * The shared distribution contract for Archon plugins: the author-owned
 * `archon-plugin.json` manifest and the local install receipt.
 *
 * The CLI installer, workflow discovery, the docs-site index and the release
 * workflow all need these shapes and names, and none of those can import
 * another, so they live in this leaf package with no dependency beyond zod.
 * Reading receipts from disk lives in `./store`, so a consumer that only
 * needs the schemas does not load filesystem code.
 */
import { z } from 'zod';

export const PLUGIN_MANIFEST_FILE = 'archon-plugin.json';

const pluginName = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase words joined by "-"');

/** The file name forge discovery scans for, without the Windows `.exe` suffix. */
const forgeExecutable = z
  .string()
  .regex(/^archon-forge-[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be archon-forge-<name>');

// `>=0.11.0`, `^1.2.0 <2.0.0`, `>=1.0.0 || ^2.0.0`: comparators on full
// versions only. Bun.semver.satisfies treats an unparseable range as matching
// every version, so a range outside this grammar is refused here rather than
// silently disabling the install-time check.
const comparator = String.raw`(?:>=|<=|>|<|=|\^|~)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
const versionRange = z
  .string()
  .regex(
    new RegExp(`^${comparator}(?: ${comparator})*(?: \\|\\| ${comparator}(?: ${comparator})*)*$`),
    'must be a semver range such as >=0.11.0'
  );

// A kind joins this schema when its install path and runtime contract exist.
// Until then its manifest is rejected, rather than accepted and half-installed.
const manifestBase = {
  schemaVersion: z.literal(1),
  name: pluginName,
  description: z.string().min(1),
  // A semver range checked against the running Archon at install time.
  compatibility: z.object({ archon: versionRange }).strict().optional(),
};

export const forgeManifestSchema = z
  .object({ ...manifestBase, kind: z.literal('forge'), executable: forgeExecutable })
  .strict();

/**
 * `<workflow folder>/<file>.yaml`, relative to the plugin root. The plugin root
 * is one workflow pack in the packaged layout (`<workflow>/<one>.yaml` with its
 * own `commands/` and `scripts/`, plus `.shared/`), so an entrypoint names
 * exactly one of its workflow folders.
 */
const entrypointPath = z
  .string()
  .regex(
    /^[A-Za-z0-9_][A-Za-z0-9._-]*\/[A-Za-z0-9_][A-Za-z0-9._-]*\.ya?ml$/,
    'must be <workflow folder>/<file>.yaml'
  )
  .refine(path => !path.includes('..'), 'must stay inside its workflow folder');

export const workflowPackManifestSchema = z
  .object({
    ...manifestBase,
    kind: z.literal('workflow-pack'),
    /**
     * The pack's public workflows, keyed by the name each is dispatched as
     * (`owner/plugin:<key>`). Every other workflow in the pack is support:
     * composable from inside the pack, never dispatchable.
     */
    entrypoints: z
      .record(pluginName, entrypointPath)
      .refine(entries => Object.keys(entries).length > 0, 'must declare at least one entrypoint')
      // One workflow has one public name; two names for one file would leave one of
      // them unresolvable.
      .refine(
        entries => new Set(Object.values(entries)).size === Object.keys(entries).length,
        'each entrypoint must name a different workflow file'
      ),
  })
  .strict();

export const pluginManifestSchema = z.discriminatedUnion('kind', [
  forgeManifestSchema,
  workflowPackManifestSchema,
]);

export type ForgeManifest = z.infer<typeof forgeManifestSchema>;
export type WorkflowPackManifest = z.infer<typeof workflowPackManifestSchema>;
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^[0-9a-f]{40}$/);

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

export const forgeReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** `owner/repo[/path]`, the location of the manifest. */
    id: z.string().min(1),
    manifest: forgeManifestSchema,
    /** The release tag the files came from. */
    tag: z.string().min(1),
    /** The commit that tag resolved to at install time. */
    commit,
    installedAt: z.iso.datetime(),
    files: z.array(installedFile).min(1),
  })
  .strict();

/**
 * A pack's files live in one tree the installer owns outright (see
 * `packTreePath` in `./store`), so the receipt names the commit instead of a
 * file list, and `remove` deletes that tree.
 */
export const workflowPackReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    manifest: workflowPackManifestSchema,
    /** Absent when the pack was installed from the default branch head. */
    tag: z.string().min(1).optional(),
    commit,
    installedAt: z.iso.datetime(),
  })
  .strict();

export const pluginReceiptSchema = z.union([forgeReceiptSchema, workflowPackReceiptSchema]);

export type ForgeReceipt = z.infer<typeof forgeReceiptSchema>;
export type WorkflowPackReceipt = z.infer<typeof workflowPackReceiptSchema>;
export type PluginReceipt = z.infer<typeof pluginReceiptSchema>;

/** Narrows on the manifest's kind, which TypeScript cannot do through a nested field. */
export function isForgeReceipt(receipt: PluginReceipt): receipt is ForgeReceipt {
  return receipt.manifest.kind === 'forge';
}

/** One line naming every failed field, for install and discovery errors. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map(issue => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * The release asset a forge executable is published as for one Bun compile
 * target (`bun-<os>-<arch>`), e.g. `archon-forge-github-windows-x64.exe`.
 * release.yml names the asset with this and the installer requests it, so the
 * two cannot drift.
 */
export function forgeReleaseAsset(executable: string, bunTarget: string): string {
  const match = /^bun-(darwin|linux|windows)-(x64|arm64)$/.exec(bunTarget);
  if (!match) throw new Error(`No forge plugin release asset is built for ${bunTarget}`);
  return `${executable}-${match[1]}-${match[2]}${match[1] === 'windows' ? '.exe' : ''}`;
}
