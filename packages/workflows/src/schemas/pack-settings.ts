/**
 * Pack settings: the settings a workflow pack declares once, in its `.pack/pack.yaml`, and
 * that every workflow of the pack reads as `$INPUTS.<name>`.
 *
 * A setting is a workflow input spec (`description`, `default`, `required`) plus a declared
 * `type` that validates its value. Values stay strings, as every `$INPUTS` value supplied
 * from the CLI already is: a `bool` is the text `true` or `false`, a `list` is
 * comma-separated text.
 */
import { z } from 'zod';
import type { WorkflowSource } from './workflow';

const settingBase = {
  description: z.string().optional(),
  required: z.boolean().optional(),
  // A bool's default may be written as a YAML boolean; it is normalized to its text.
  default: z.union([z.string(), z.boolean()]).optional(),
};

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
  z.discriminatedUnion('type', [
    z.object({ ...settingBase, type: z.enum(['string', 'bool', 'list']) }).strict(),
    z
      .object({
        ...settingBase,
        type: z.literal('enum'),
        values: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  ])
);

interface PackSettingBase {
  readonly description?: string;
  readonly required?: boolean;
  /** Already validated against the setting's type. */
  readonly default?: string;
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
 */
export interface WorkflowPack {
  readonly key: string;
  readonly source: WorkflowSource;
  readonly settings?: Readonly<Record<string, PackSettingSpec>>;
}
