export const FIRST_PARTY_PLUGIN_REPO = 'coleam00/Archon';

/**
 * The shared distribution contract for Archon plugins: the author-owned
 * `archon-plugin.json` manifest and the local install receipt.
 *
 * The CLI installer, workflow discovery, the docs-site index and the release
 * workflow all need these shapes and names, and none of those can import
 * another, so they share this package. Descriptors are owned by the corresponding
 * provider or chat contract.
 * Reading receipts from disk lives in `./store`, so a consumer that only
 * needs the schemas does not load filesystem code.
 */
import { z } from 'zod';
import { type MAINTAINED_PROVIDER_IDS } from '@archon/provider-contract';
import { chatPluginDescriptorSchema } from '@archon/chat-contract/descriptor';
import { releaseAsset } from '@archon/paths/release-asset';
import { providerPluginDescriptorSchema } from '@archon/provider-contract/plugin/wire';

export function maintainedProviderPluginId(id: (typeof MAINTAINED_PROVIDER_IDS)[number]): string {
  return `${FIRST_PARTY_PLUGIN_REPO}/plugins/provider-${id}`;
}

export function isMaintainedProviderPlugin(
  pluginId: string,
  id: (typeof MAINTAINED_PROVIDER_IDS)[number]
): boolean {
  return pluginId.toLowerCase() === maintainedProviderPluginId(id).toLowerCase();
}

export const PLUGIN_MANIFEST_FILE = 'archon-plugin.json';

export function isPluginPathSegment(segment: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..';
}

export function isPluginId(id: string): boolean {
  const [owner = '', repo = '', ...path] = id.split('/');
  return (
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner) &&
    [repo, ...path].every(isPluginPathSegment)
  );
}

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

// A kind joins this schema when its install path and wire contract exist.
// Until then its manifest is rejected, rather than accepted and half-installed.
//
// Manifest and receipt objects strip keys they do not declare, so a newer
// Archon can add a field without breaking an older binary that reads the same
// pack or receipt. A change older binaries must not read past bumps
// `schemaVersion`, which stays a literal.
const manifestBase = {
  schemaVersion: z.literal(1),
  name: pluginName,
  description: z.string().min(1),
  // A semver range checked against the running Archon at install time.
  compatibility: z.object({ archon: versionRange }).optional(),
};

export const providerManifestSchema = z.object({
  ...manifestBase,
  kind: z.literal('provider'),
  executable: z
    .string()
    .regex(/^archon-provider-[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be archon-provider-<name>'),
});

export const chatManifestSchema = z.object({
  ...manifestBase,
  kind: z.literal('chat'),
  executable: z
    .string()
    .regex(/^archon-chat-[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be archon-chat-<name>'),
});

export const forgeManifestSchema = z.object({
  ...manifestBase,
  kind: z.literal('forge'),
  executable: forgeExecutable,
});

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

/** The folder `archon skill add` writes the Archon skill to, in each skill root. */
export const ARCHON_SKILL_NAME = 'archon-cli';
/** Retired Archon skill folders `archon skill add` deletes from each skill root on every run. */
export const RETIRED_ARCHON_SKILL_NAMES = ['archon', 'manage-run'] as const;
// A pack skill under any of these names would be overwritten or deleted by `archon skill add`.
const reservedSkillNames: readonly string[] = [ARCHON_SKILL_NAME, ...RETIRED_ARCHON_SKILL_NAMES];

/** A folder relative to the plugin root, such as `skill` or `skills/review-kit`. */
const skillPath = z
  .string()
  .refine(
    path => path.split('/').every(isPluginPathSegment),
    'must be a relative folder inside the plugin, such as skill or skills/<name>'
  );

export const workflowPackManifestSchema = z.object({
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
  /**
   * The pack's own document: one markdown file, relative to the plugin root, that explains
   * the pack to an operator. Its frontmatter may declare `groups` of stages for display.
   */
  document: z
    .string()
    .regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*\.md$/, 'must be a .md file inside the pack')
    .refine(path => !path.split('/').includes('..'), 'must stay inside the pack')
    .optional(),
  /**
   * The agent skill the pack ships for the operator's own agent: the folder at `path`
   * (a `SKILL.md` plus reference files), installed by `archon skill add --pack <id>`
   * under `.claude/skills/<name>` and `.agents/skills/<name>`. It changes nothing about
   * which skills a workflow node gets.
   */
  skill: z
    .object({
      name: pluginName.refine(name => !reservedSkillNames.includes(name), {
        error: issue =>
          `"${String(issue.input)}" is ${issue.input === ARCHON_SKILL_NAME ? 'the name of the Archon skill' : 'a retired Archon skill folder that archon skill add deletes'}; choose another skill name`,
      }),
      path: skillPath,
    })
    .optional(),
});

export const pluginManifestSchema = z.discriminatedUnion('kind', [
  forgeManifestSchema,
  providerManifestSchema,
  chatManifestSchema,
  workflowPackManifestSchema,
]);

/**
 * Dotted paths of keys in a raw manifest that its kind's schema does not
 * declare, such as `skils` or `compatibility.min`. Readers ignore these keys;
 * only `archon validate` calls this, so an author sees a typo instead of
 * losing it silently. An unknown kind or a non-object returns `[]`: parsing
 * reports those.
 */
export function unknownManifestKeys(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  const schema = pluginManifestSchema.options.find(option => option.shape.kind.value === raw.kind);
  return schema ? unknownKeys(schema, raw, '') : [];
}

function unknownKeys(
  schema: z.ZodObject,
  value: Record<string, unknown>,
  prefix: string
): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    if (!Object.hasOwn(schema.shape, key)) return [prefix + key];
    const field = schema.shape[key];
    const inner = field instanceof z.ZodOptional ? field.unwrap() : field;
    // Records such as `entrypoints` are not walked: their keys are names, not fields.
    return inner instanceof z.ZodObject && isRecord(child)
      ? unknownKeys(inner, child, `${prefix}${key}.`)
      : [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ChatManifest = z.infer<typeof chatManifestSchema>;
export type ProviderManifest = z.infer<typeof providerManifestSchema>;
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
const installedFile = z.object({
  path: z
    .string()
    .regex(/^[^/\\]+$/)
    .refine(path => path !== '.' && path !== '..', 'must name a file'),
  sha256,
});

export const forgeReceiptSchema = z.object({
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
});

export const providerReceiptSchema = forgeReceiptSchema.extend({
  manifest: providerManifestSchema,
  descriptor: providerPluginDescriptorSchema,
});

export const chatReceiptSchema = forgeReceiptSchema.extend({
  manifest: chatManifestSchema,
  descriptor: chatPluginDescriptorSchema,
});

/**
 * A pack's files live in one tree the installer owns outright (see
 * `packTreePath` in `./store`), so the receipt names the commit instead of a
 * file list, and `remove` deletes that tree.
 */
export const workflowPackReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  manifest: workflowPackManifestSchema,
  /** Absent when the pack was installed from the default branch head. */
  tag: z.string().min(1).optional(),
  commit,
  installedAt: z.iso.datetime(),
});

export const pluginReceiptSchema = z.union([
  forgeReceiptSchema,
  providerReceiptSchema,
  chatReceiptSchema,
  workflowPackReceiptSchema,
]);

export type ChatReceipt = z.infer<typeof chatReceiptSchema>;
export type ProviderReceipt = z.infer<typeof providerReceiptSchema>;
export type ForgeReceipt = z.infer<typeof forgeReceiptSchema>;
export type WorkflowPackReceipt = z.infer<typeof workflowPackReceiptSchema>;
export type PluginReceipt = z.infer<typeof pluginReceiptSchema>;

/** Narrows on the manifest's kind, which TypeScript cannot do through a nested field. */
export function isForgeReceipt(receipt: PluginReceipt): receipt is ForgeReceipt {
  return receipt.manifest.kind === 'forge';
}

export function isProviderReceipt(receipt: PluginReceipt): receipt is ProviderReceipt {
  return receipt.manifest.kind === 'provider';
}

export function isChatReceipt(receipt: PluginReceipt): receipt is ChatReceipt {
  return receipt.manifest.kind === 'chat';
}

export function isBinaryReceipt(
  receipt: PluginReceipt
): receipt is ForgeReceipt | ProviderReceipt | ChatReceipt {
  return isForgeReceipt(receipt) || isProviderReceipt(receipt) || isChatReceipt(receipt);
}

/** One line naming every failed field, for install and discovery errors. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map(issue => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * The release asset a plugin executable is published as for one Bun compile
 * target (`bun-<os>-<arch>`), e.g. `archon-forge-github-windows-x64.exe`.
 * release.yml names the asset with this and the installer requests it, so the
 * two cannot drift.
 */
export function pluginReleaseAsset(executable: string, bunTarget: string): string {
  return releaseAsset(executable, bunTarget);
}
