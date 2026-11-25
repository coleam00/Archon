/**
 * Pack settings: the settings a workflow pack declares once, in its `.pack/pack.yaml`, and
 * that every workflow of the pack reads as `$INPUTS.<name>`.
 *
 * A setting is a workflow input spec (`description`, `default`, `required`) plus a declared
 * `type` that validates its value, and two facts for a reader that lists settings: the
 * `section` it belongs to and whether its value names a `file`. Values stay strings, as
 * every `$INPUTS` value supplied from the CLI already is: a `bool` is the text `true` or
 * `false`, a `list` is comma-separated text.
 *
 * A setting's unknown keys are stripped, not refused, so a pack can adopt a key a newer
 * Archon adds without breaking an older one; `parsePackDeclaration` reports them as
 * warnings so a typo stays visible.
 */
import { z } from 'zod';
import type { PackBinding } from './pack-bindings';
import type { WorkflowSource } from './workflow';

const settingBase = {
  description: z.string().optional(),
  required: z.boolean().optional(),
  // A bool's default may be written as a YAML boolean; it is normalized to its text.
  default: z.union([z.string(), z.boolean()]).optional(),
  section: z.string().min(1).optional(),
  file: z.boolean().optional(),
};

// Unknown keys are stripped, but `values` on a non-enum stays an error: it is a known key
// in the wrong place, not one a newer Archon may have added.
const plainSetting = z.object({
  ...settingBase,
  type: z.enum(['string', 'bool', 'list']),
  values: z.undefined({ error: "'values' belongs to an 'enum' setting only" }).optional(),
});
const enumSetting = z.object({
  ...settingBase,
  type: z.literal('enum'),
  values: z.array(z.string().min(1)).min(1),
});

/**
 * Where a fresh run's value for a setting came from, in the order start resolves it: each
 * beats the ones after it.
 */
export const PACK_SETTING_ORIGINS = [
  'supplied',
  'project',
  'workflow_default',
  'pack_default',
] as const;
export type PackSettingOrigin = (typeof PACK_SETTING_ORIGINS)[number];

/** Every key a setting may carry, derived from the schema so the two cannot drift. */
export const PACK_SETTING_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(plainSetting.shape),
  ...Object.keys(enumSetting.shape),
]);

/**
 * The authored shape of one setting. `values` belongs to `enum` and only to `enum`: the
 * discriminated union makes an enum without members, or members on another type, a
 * schema error rather than something a reader has to remember.
 */
export const packSettingSpecSchema = z.preprocess(
  raw =>
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) && !('type' in raw)
      ? { ...raw, type: 'string' }
      : raw,
  z.discriminatedUnion('type', [plainSetting, enumSetting])
);

interface PackSettingBase {
  readonly description?: string;
  readonly required?: boolean;
  /** Already validated against the setting's type. */
  readonly default?: string;
  /**
   * A grouping name for a reader that lists settings: settings sharing one belong together,
   * in the pack's order. The engine never interprets it.
   */
  readonly section?: string;
  /** Present only as `true`: the value is a path to a file, relative to the project or absolute. */
  readonly file?: true;
}

/** One validated setting declaration. */
export type PackSettingSpec =
  | (PackSettingBase & { readonly type: 'string' | 'bool' | 'list' })
  | (PackSettingBase & { readonly type: 'enum'; readonly values: readonly string[] });

/**
 * The pack a discovered workflow belongs to. Set by discovery, never by YAML: a workflow
 * file cannot claim a pack it was not loaded from.
 *
 * `key` names the pack's settings: the scope folder name for a project, home or bundled
 * pack, and `<owner>.<manifest name>` for an installed one (never its install path).
 * `source` is the scope it was loaded from. Together they locate the pack's directory
 * under whichever source roots a run reads (`packDirectory`); the path itself is not
 * stored, because a run's capture moves after discovery reads it.
 * `settings` is the pack's declaration, absent when the pack declares none.
 * `bindings` is the trigger bindings the pack recommends, by id; no run reads them.
 * `forge` is what the pack's workflows need from the forge; a fresh run of any of them is
 * refused at start when the run's repository cannot serve it.
 */
export interface WorkflowPack {
  readonly key: string;
  readonly source: WorkflowSource;
  readonly settings?: Readonly<Record<string, PackSettingSpec>>;
  readonly bindings?: Readonly<Record<string, PackBinding>>;
  readonly forge?: PackForgeNeeds;
}

/**
 * A workflow's pack, with `workflow`, its authored `name:`. That is how the pack's own
 * files and bindings name it, and it stays the same when an installed pack's catalog
 * publishes the workflow as `owner/plugin:<entrypoint>`, whose entrypoint may differ.
 */
export interface WorkflowPackMember extends WorkflowPack {
  readonly workflow: string;
  /**
   * The `file: true` settings this workflow reads (`packSettingReads`), set by include
   * expansion, which alone sees command and named-script bodies. A fresh run checks only
   * these files. Absent, as on a workflow built outside discovery, every file setting counts.
   */
  readonly fileSettingReads?: readonly string[];
}

/**
 * The authored `forge:` block: the capability tokens the pack calls, each an operation
 * name or a finer token a plugin advertises, such as `resolve:subject`. `repository`
 * names the two workflow inputs that carry the repository a run acts on; a run that sets
 * both is checked against that repository instead of its checkout's remotes.
 */
export const packForgeNeedsSchema = z
  .object({
    operations: z.array(z.string().min(1)).min(1),
    repository: z
      .object({ host: z.string().min(1), path: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
export type PackForgeNeeds = z.infer<typeof packForgeNeedsSchema>;
