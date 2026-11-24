/**
 * How a pack is configured, for the console's read-only Settings page: the settings the pack
 * declares (`<pack>/.pack/pack.yaml`, `inputs:`, in its order), and what each project that
 * runs it sets (`.archon/packs/<pack key>.yaml`, `settings:`). Nothing here names a setting:
 * the declaration gives the names, defaults and descriptions, and the factory overview's
 * `settings` map (`schemas/factory-overview.ts`) says which run as a shadow (and what changes
 * when one stops being one), which point to a file, and which of the overview's
 * `setting_sections` each is shown in. A file a setting points to is looked up in the
 * project's checkout; the checks file is read and listed.
 *
 * This only reads, and only for display: a run resolves its settings itself
 * (`pack-settings.ts`), and refuses a project file this page still shows.
 */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { factoryPackKey } from './factory-pack-files';
import { readPackDeclarations } from './pack-declarations';
import {
  PackSettingsError,
  packSettingValue,
  parsePackDeclaration,
  readProjectPackSettingsRaw,
} from './pack-settings';
import { PACK_DECLARATION_PATH } from './packaged-workflow';
import { factoryChecksFileSchema } from './schemas/factory-checks';
import {
  type FactoryOverview,
  factoryOverviewIconSchema,
  factoryOverviewKindSchema,
} from './schemas/factory-overview';
import type { PackSettingSpec } from './schemas/pack-settings';
import type { LiveWorkflowSourceRoots } from './workflow-source/roots';

const pointsToSchema = z.enum(['policy', 'checks']);

/** A file a setting's value names, looked up in the project's checkout. */
const settingFileSchema = z.object({
  /** The path relative to the project, with `/`; the absolute path when it lies outside. */
  display: z.string(),
  /** The absolute path. */
  full: z.string(),
  status: z.enum(['found', 'missing', 'unreadable']),
  /** Why the file is unreadable; null otherwise. */
  error: z.string().nullable(),
  /** A checks file's checks, in its order; null for a policy or a checks file not read. */
  checks: z.array(z.object({ name: z.string(), run: z.string() })).nullable(),
});

/** What one project sets for one declared setting. */
const settingValueSchema = z.discriminatedUnion('state', [
  /** The project's file leaves the key out, or there is no file. */
  z.object({ state: z.literal('unset') }),
  /** The project's file sets the key to empty text. */
  z.object({ state: z.literal('empty') }),
  z.object({
    state: z.literal('set'),
    /** The value as text; a value YAML did not read as text is shown as YAML read it. */
    value: z.string(),
    /** Why a run would refuse this value (its type check); null when it would not. */
    problem: z.string().nullable(),
    /** The file the value names, when the setting points to one and the value is valid. */
    file: settingFileSchema.nullable(),
  }),
]);

export const factoryPackSettingsSchema = z.object({
  /** The pack's key (`owner.name` when installed). */
  pack: z.string(),
  /** The declaration read, or null when no pack with this key ships `.pack/pack.yaml`. */
  declaration: z.object({ path: z.string(), error: z.string().nullable() }).nullable(),
  /** Where each project sets the pack's values, relative to the project. */
  settingsFile: z.string(),
  /**
   * The overview's sections for the page, in its order (`setting_sections`); empty when it
   * lists none.
   */
  sections: z.array(
    z.object({
      id: z.string(),
      eyebrow: z.string(),
      title: z.string(),
      kind: factoryOverviewKindSchema,
      icon: factoryOverviewIconSchema,
    })
  ),
  /** Every setting the pack declares, in the declaration's order. */
  settings: z.array(
    z.object({
      name: z.string(),
      description: z.string().nullable(),
      default: z.string().nullable(),
      type: z.enum(['string', 'bool', 'list', 'enum']),
      shadow: z.boolean(),
      pointsTo: pointsToSchema.nullable(),
      /** The section the overview shows it in; null when it names none. */
      section: z.string().nullable(),
      /** A shadow's line on what changes when it stops being one; null when the map gives none. */
      whenLive: z.string().nullable(),
    })
  ),
  /** Keys of the factory overview's `settings` map that the declaration does not declare. */
  mapErrors: z.array(z.string()),
  /** Each project that runs the pack, by name. */
  projects: z.array(
    z.object({
      codebaseId: z.string(),
      name: z.string(),
      /** Why the project's settings file could not be read; its values are then empty. */
      error: z.string().nullable(),
      /** One entry per declared setting, by name. */
      values: z.record(z.string(), settingValueSchema),
      /** Keys the project's file sets that the pack does not declare, as the file has them. */
      undeclared: z.array(z.object({ name: z.string(), value: z.string() })),
    })
  ),
});
export type FactoryPackSettings = z.infer<typeof factoryPackSettingsSchema>;
type SettingValue = z.infer<typeof settingValueSchema>;
type SettingFile = z.infer<typeof settingFileSchema>;
type PointsTo = z.infer<typeof pointsToSchema>;

/** A pack's declared settings in order, or why its declaration could not be read. */
export type FoundPackDeclaration =
  | { path: string; settings: [string, PackSettingSpec][] }
  | { path: string; error: string };

/**
 * The `.pack/pack.yaml` of the pack keyed `packKey` under `roots`, found as every other pack
 * display file is (`readPackDeclarations`); null when no pack with that key ships one. A file
 * that cannot be read or parsed is returned with its error, never thrown.
 */
export async function findPackDeclaration(
  roots: LiveWorkflowSourceRoots,
  packKey: string
): Promise<FoundPackDeclaration | null> {
  const reads = await readPackDeclarations(roots, PACK_DECLARATION_PATH);
  const read = reads.find(candidate => factoryPackKey(candidate.pack) === packKey);
  if (read === undefined) return null;
  if ('error' in read) return { path: read.path, error: read.error };
  try {
    const declared = parsePackDeclaration(read.content, read.path);
    return { path: read.path, settings: Object.entries(declared.settings ?? {}) };
  } catch (error) {
    if (!(error instanceof PackSettingsError)) throw error;
    return { path: read.path, error: error.message };
  }
}

interface ProjectCheckout {
  codebaseId: string;
  name: string;
  cwd: string;
}

/**
 * The Settings page of the pack keyed `packKey`: its declared settings, presented as the
 * overview's `map` says, and what each of `projects` sets. One project's unreadable file is
 * reported on that project and never hides the others.
 */
export async function readFactoryPackSettings(input: {
  packKey: string;
  declaration: FoundPackDeclaration | null;
  map: FactoryOverview['settings'];
  sections?: FactoryOverview['setting_sections'];
  projects: readonly ProjectCheckout[];
}): Promise<FactoryPackSettings> {
  const { packKey, declaration, map = {} } = input;
  const sections = input.sections ?? [];
  const settingsFile = `.archon/packs/${packKey}.yaml`;
  const head = {
    pack: packKey,
    declaration:
      declaration === null
        ? null
        : { path: declaration.path, error: 'error' in declaration ? declaration.error : null },
    settingsFile,
  };
  // Without the declaration there is nothing to read a project's values against.
  if (declaration !== null && 'error' in declaration)
    return { ...head, sections: [], settings: [], mapErrors: [], projects: [] };

  const declared = (declaration?.settings ?? []).map(([name, spec]) => {
    const shown = Object.hasOwn(map, name) ? map[name] : undefined;
    return {
      name,
      spec,
      shadow: shown?.shadow === true,
      pointsTo: shown?.points_to ?? null,
      section: shown?.section ?? null,
      whenLive: shown?.when_live ?? null,
    };
  });
  const names = new Set(declared.map(({ name }) => name));
  const declaredIn = declaration?.path ?? `no ${PACK_DECLARATION_PATH}`;
  const mapErrors = Object.keys(map)
    .filter(name => !names.has(name))
    .map(
      name =>
        `The factory overview presents setting "${name}", which the pack does not declare (${declaredIn})`
    );
  const projects = await Promise.all(
    input.projects.map(project => readProject(project, packKey, declared))
  );
  const settings = declared.map(({ name, spec, shadow, pointsTo, section, whenLive }) => ({
    name,
    description: spec.description ?? null,
    default: spec.default ?? null,
    type: spec.type,
    shadow,
    pointsTo,
    section,
    whenLive,
  }));
  return { ...head, sections, settings, mapErrors, projects };
}

async function readProject(
  project: ProjectCheckout,
  packKey: string,
  declared: readonly { name: string; spec: PackSettingSpec; pointsTo: PointsTo | null }[]
): Promise<FactoryPackSettings['projects'][number]> {
  const ref = { codebaseId: project.codebaseId, name: project.name };
  let raw: Record<string, unknown> | undefined;
  try {
    raw = (await readProjectPackSettingsRaw(project.cwd, packKey)).settings;
  } catch (error) {
    if (!(error instanceof PackSettingsError)) throw error;
    return { ...ref, error: error.message, values: {}, undeclared: [] };
  }
  const file = raw ?? {};
  const values: Record<string, SettingValue> = {};
  for (const { name, spec, pointsTo } of declared) {
    const value = Object.hasOwn(file, name) ? file[name] : undefined;
    values[name] = await settingValue(spec, value, project.cwd, pointsTo);
  }
  const names = new Set(declared.map(({ name }) => name));
  const undeclared = Object.entries(file)
    .filter(([name]) => !names.has(name))
    .map(([name, value]) => ({ name, value: asText(value) }));
  return { ...ref, error: null, values, undeclared };
}

async function settingValue(
  spec: PackSettingSpec,
  raw: unknown,
  cwd: string,
  pointsTo: PointsTo | null
): Promise<SettingValue> {
  if (raw === undefined) return { state: 'unset' };
  if (raw === '') return { state: 'empty' };
  const checked = packSettingValue(spec, raw);
  if ('error' in checked)
    return { state: 'set', value: asText(raw), problem: checked.error, file: null };
  const file = pointsTo === null ? null : await pointedFile(cwd, checked.value, pointsTo);
  return { state: 'set', value: checked.value, problem: null, file };
}

/** A value as the project's file has it: text as is, anything else as YAML read it. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : Bun.inspect(value, { depth: 0, colors: false });
}

/** The file `value` names, relative to the project unless absolute, as the pack reads it. */
async function pointedFile(cwd: string, value: string, pointsTo: PointsTo): Promise<SettingFile> {
  const full = isAbsolute(value) ? normalize(value) : resolve(cwd, value);
  const rel = relative(cwd, full);
  const outside = rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  const shown = { display: outside ? full : rel.split(sep).join('/'), full };
  return pointsTo === 'checks' ? checksFile(shown) : policyFile(shown);
}

type Shown = Pick<SettingFile, 'display' | 'full'>;

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

async function policyFile(shown: Shown): Promise<SettingFile> {
  try {
    const found = await stat(shown.full);
    if (found.isDirectory())
      return { ...shown, status: 'unreadable', error: 'is a folder, not a file', checks: null };
    return { ...shown, status: 'found', error: null, checks: null };
  } catch (error) {
    if (isMissing(error)) return { ...shown, status: 'missing', error: null, checks: null };
    return { ...shown, status: 'unreadable', error: (error as Error).message, checks: null };
  }
}

async function checksFile(shown: Shown): Promise<SettingFile> {
  let text: string;
  try {
    text = await readFile(shown.full, 'utf8');
  } catch (error) {
    if (isMissing(error)) return { ...shown, status: 'missing', error: null, checks: null };
    return { ...shown, status: 'unreadable', error: (error as Error).message, checks: null };
  }
  const unreadable = (error: string): SettingFile => ({
    ...shown,
    status: 'unreadable',
    error,
    checks: null,
  });
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text.replaceAll('\r\n', '\n'));
  } catch (error) {
    return unreadable(`not valid YAML: ${(error as Error).message}`);
  }
  const parsed = factoryChecksFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` at '${issue.path.join('.')}'` : '';
    return unreadable(
      `does not list checks under 'checks:', each with a name and a command to run${where}`
    );
  }
  return {
    ...shown,
    status: 'found',
    error: null,
    checks: parsed.data.checks.map(({ name, run }) => ({ name, run })),
  };
}
