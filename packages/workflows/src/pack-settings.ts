/**
 * Pack settings: declared once by a pack, valued per project, resolved once per run.
 *
 *  - The DECLARATION is `<pack>/.pack/pack.yaml`, a top-level `inputs:` block in the
 *    workflow input-spec shape plus a `type`, and optionally a `section` and `file: true`. (The same file's `bindings:` block holds the
 *    trigger bindings the pack recommends; see `schemas/pack-bindings.ts`. Its `forge:` block
 *    names the forge capabilities the pack calls; see `run-forge-access.ts`.) It lives in a dot folder because neither
 *    workflow loader reads one at a pack root: the flat loader would parse a `.yaml` beside
 *    the workflow folders as a workflow of its own, and the packaged loader skips dot
 *    folders as it does `.shared/`. A source capture copies the pack tree whole, so a
 *    resumed run or a child run reads the declaration its source was captured with.
 *  - The PROJECT VALUES are `.archon/packs/<pack key>.yaml`, a top-level `settings:` map,
 *    read from the run's working directory. (`config.<name>.yaml` already names a
 *    `--config` run layer, so that spelling is not reused.)
 *  - A run RESOLVES them once, when it starts, and stores the result on its row: the
 *    declaration default, then the workflow's own input default, then the project file,
 *    then the run's supplied inputs. Both defaults are the author's; the project file is
 *    the project's choice and beats them. A resume reads the row, never the files.
 *
 * Settings belong to a run, not to a node: a run reads its root workflow's pack, and a
 * `workflow:` child, being a run of its own, reads its own. An `include:`d block from the
 * includer's own pack reads the settings the run resolved, as it does run directly; one
 * from another pack takes nothing from its pack, and its includer passes what it needs
 * through `with:` (`include/inline.ts`).
 */
import { readFile, stat } from 'fs/promises';
import type { z } from 'zod';
import { isAbsolute, join, sep } from 'path';
import { inputEnvKeyCollision } from './loader/workflow-fields';
import { parsePackBindings } from './pack-bindings';
import { PACK_DECLARATION_PATH } from './packaged-workflow';
import type { JsonValue } from './output-ref';
import { INPUT_NAME_PATTERN } from './schemas/node-bindings';
import type { ResolvedWorkflow } from './schemas';
import type { PackBinding } from './schemas/pack-bindings';
import {
  PACK_SETTING_KEYS,
  packForgeNeedsSchema,
  packSettingSpecSchema,
  type PackForgeNeeds,
  type PackSettingSpec,
  type WorkflowPack,
} from './schemas/pack-settings';
import { defaultRunInputs } from './workflow-inputs';

/** Every pack-settings failure a caller reports: it names the file and the key. */
export class PackSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackSettingsError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseYamlText(text: string): unknown {
  return Bun.YAML.parse(text.replaceAll('\r\n', '\n'));
}

/**
 * A setting's value as its text, or the reason it is not one. YAML booleans are accepted
 * for a `bool` only; any other non-string (a YAML number, say) is refused rather than
 * stringified, because YAML has already changed it (`1.10` reads as `1.1`).
 */
export function packSettingValue(
  spec: PackSettingSpec,
  raw: unknown
): { value: string } | { error: string } {
  if (typeof raw === 'boolean' && spec.type === 'bool') return { value: String(raw) };
  if (typeof raw !== 'string') {
    return {
      error: `must be a string (quote it in YAML), got ${Bun.inspect(raw, { depth: 0, colors: false })}`,
    };
  }
  switch (spec.type) {
    case 'string':
      return { value: raw };
    case 'bool':
      return raw === 'true' || raw === 'false'
        ? { value: raw }
        : { error: `must be true or false, got '${raw}'` };
    case 'enum':
      return spec.values.includes(raw)
        ? { value: raw }
        : { error: `must be one of ${spec.values.join(', ')}, got '${raw}'` };
    case 'list':
      return raw === '' || raw.split(',').every(item => item.trim() !== '')
        ? { value: raw }
        : { error: `must be a comma-separated list with no empty items, got '${raw}'` };
  }
}

/** Throws a {@link PackSettingsError} prefixed with the file it is about. */
export type Fail = (detail: string) => never;

function failIn(label: string): Fail {
  return detail => {
    throw new PackSettingsError(`${label}: ${detail}`);
  };
}

/**
 * The mapping under each of a file's allowed top-level keys; a key that is absent or empty
 * is left out. Any other top-level key fails: an unknown key is a typo, not a no-op.
 */
function topLevelMappings<K extends string>(
  text: string,
  keys: readonly K[],
  fail: Fail
): Partial<Record<K, Record<string, unknown>>> {
  const allowed = keys.map(key => `'${key}:'`).join(', ');
  let raw: unknown;
  try {
    raw = parseYamlText(text);
  } catch (error) {
    return fail(`not valid YAML: ${(error as Error).message}`);
  }
  if (raw === null || raw === undefined) return {};
  if (!isPlainObject(raw)) return fail(`must be a mapping with ${allowed}`);
  const unknown = Object.keys(raw).find(k => !keys.some(key => key === k));
  if (unknown !== undefined)
    return fail(`unknown key '${unknown}'; this file holds only ${allowed}`);
  const mappings: Partial<Record<K, Record<string, unknown>>> = {};
  for (const key of keys) {
    const inner = raw[key];
    if (inner === undefined || inner === null) continue;
    if (!isPlainObject(inner)) return fail(`'${key}' must be a mapping`);
    mappings[key] = inner;
  }
  return mappings;
}

/** One validated setting declaration; its default already checked against its type. */
function parseSettingSpec(name: string, rawSpec: unknown, fail: Fail): PackSettingSpec {
  if (!INPUT_NAME_PATTERN.test(name)) {
    fail(
      `input '${name}' is not a valid name: start with a letter or underscore, then letters, digits, underscores or hyphens`
    );
  }
  // Assigning `__proto__` to a plain object sets its prototype, so the value would vanish.
  if (name === '__proto__') fail(`'__proto__' cannot be a setting name`);
  const parsed = packSettingSpecSchema.safeParse(rawSpec ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` at '${issue.path.join('.')}'` : '';
    return fail(`input '${name}' is invalid${where}: ${issue?.message ?? 'unknown error'}`);
  }
  const rawDefault = parsed.data.default;
  const spec = authoredSpec(name, parsed.data, fail);
  if (rawDefault === undefined) return spec;
  if (spec.required === true) {
    fail(`input '${name}' sets both 'required' and 'default'; a default makes it optional`);
  }
  const checked = packSettingValue(spec, rawDefault);
  if ('error' in checked) return fail(`input '${name}' default ${checked.error}`);
  return { ...spec, default: checked.value };
}

/**
 * The parsed spec without its unchecked default, with `file` kept only as `true`
 * (`file: false` says nothing) and only on a string setting.
 */
function authoredSpec(
  name: string,
  parsed: z.infer<typeof packSettingSpecSchema>,
  fail: Fail
): PackSettingSpec {
  if (parsed.file === true && parsed.type !== 'string') {
    fail(
      `input '${name}' sets 'file' but is type '${parsed.type}'; only a string setting names a file`
    );
  }
  if (parsed.type === 'enum') {
    const { default: _default, file: _file, ...spec } = parsed;
    return spec;
  }
  const { default: _default, file, values: _values, ...spec } = parsed;
  return file === true ? { ...spec, file: true } : spec;
}

/** The keys of an authored setting this Archon does not know; the schema strips them. */
function ignoredSettingKeys(rawSpec: unknown): string[] {
  return isPlainObject(rawSpec)
    ? Object.keys(rawSpec).filter(key => !PACK_SETTING_KEYS.has(key))
    : [];
}

/** What a pack's `.pack/pack.yaml` declares; a key is absent when the pack declares none. */
export interface PackDeclaration {
  readonly settings?: Record<string, PackSettingSpec>;
  readonly bindings?: Record<string, PackBinding>;
  readonly forge?: PackForgeNeeds;
  /**
   * Keys of a setting this Archon ignored, one message each. Discovery adds them to each
   * pack workflow's parse warnings; they stay off `WorkflowPack`, which runs carry.
   */
  readonly warnings?: readonly string[];
}

/**
 * Parse a pack declaration: a top-level `inputs:` map of settings, a top-level
 * `bindings:` map of the trigger bindings the pack recommends, and a top-level `forge:`
 * block of the forge capabilities its workflows call. Each setting name follows
 * the input-name grammar, each spec the setting schema, and each default its own type.
 * Two names folding to one `INPUTS_*` key are refused here, where all are visible.
 *
 * @param label how errors name the file.
 * @throws PackSettingsError naming the file and the key.
 */
export function parsePackDeclaration(text: string, label: string): PackDeclaration {
  const fail = failIn(label);
  const declared = topLevelMappings(text, ['inputs', 'bindings', 'forge'], fail);
  const settings: Record<string, PackSettingSpec> = {};
  const warnings: string[] = [];
  for (const [name, rawSpec] of Object.entries(declared.inputs ?? {})) {
    settings[name] = parseSettingSpec(name, rawSpec, fail);
    for (const key of ignoredSettingKeys(rawSpec)) {
      warnings.push(`${label}: input '${name}': unknown key '${key}' is ignored`);
    }
  }
  const collision = inputEnvKeyCollision(Object.keys(settings));
  if (collision !== null) fail(collision);
  const bindings = parsePackBindings(declared.bindings ?? {}, fail);
  const forge = declared.forge === undefined ? undefined : parseForgeNeeds(declared.forge, fail);
  return {
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
    ...(Object.keys(bindings).length > 0 ? { bindings } : {}),
    ...(forge ? { forge } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function parseForgeNeeds(raw: Record<string, unknown>, fail: Fail): PackForgeNeeds {
  const parsed = packForgeNeedsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? ` at '${issue.path.join('.')}'` : '';
  return fail(`'forge' is invalid${where}: ${issue?.message ?? 'unknown error'}`);
}

/**
 * Read a pack directory's declaration. A pack with no `.pack/pack.yaml` declares nothing.
 *
 * @param label how errors name the pack, e.g. its folder or `owner/name`.
 * @throws PackSettingsError on an unreadable or invalid declaration.
 */
export async function loadPackDeclaration(
  packPath: string,
  label: string
): Promise<PackDeclaration> {
  const fileLabel = `${label}/${PACK_DECLARATION_PATH}`;
  const text = await readOptionalFile(join(packPath, PACK_DECLARATION_PATH), failIn(fileLabel));
  return text === undefined ? {} : parsePackDeclaration(text, fileLabel);
}

/** A file's text, or undefined when it does not exist. */
async function readOptionalFile(path: string, fail: Fail): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return fail(`could not be read: ${(error as Error).message}`);
  }
}

/** Where a project sets a pack's values. */
export function projectPackSettingsPath(cwd: string, packKey: string): string {
  return join(cwd, '.archon', 'packs', `${packKey}.yaml`);
}

/**
 * The values this project sets for a pack in `.archon/packs/<key>.yaml`. A missing file
 * sets nothing; an unknown key, a value of the wrong type, or any top-level key other than
 * `settings:` fails.
 *
 * @throws PackSettingsError naming the file and the key.
 */
export async function readProjectPackSettings(
  cwd: string,
  pack: WorkflowPack
): Promise<Record<string, string>> {
  return readProjectValues(cwd, pack.key, pack.settings ?? {});
}

/** One declared setting, with the value the project sets for it when it sets one. */
export interface PackSettingEntry {
  readonly name: string;
  readonly spec: PackSettingSpec;
  /** The project's value; absent when the project leaves the setting to its default. */
  readonly value?: string;
}

/**
 * A pack's settings in the order the pack declares them, each with its declaration
 * (description, default, section, file marker) and the project's value. This is the read
 * a host lists settings from.
 *
 * @throws PackSettingsError on an invalid project file, as {@link readProjectPackSettings}.
 */
export async function readPackSettingEntries(
  cwd: string,
  pack: WorkflowPack
): Promise<PackSettingEntry[]> {
  const values = await readProjectPackSettings(cwd, pack);
  return Object.entries(pack.settings ?? {}).map(([name, spec]) =>
    Object.hasOwn(values, name) ? { name, spec, value: values[name] } : { name, spec }
  );
}

/**
 * Check project values without requiring inputs that an invocation may supply, and that
 * each `file` setting names a file that exists. Only `archon validate` runs the file
 * check: a stage reads the file itself, so a run does not stat it at start.
 */
export async function validateProjectPackSettings(
  cwd: string,
  pack: WorkflowPack
): Promise<string[]> {
  const errors: string[] = [];
  const path = projectPackSettingsPath(cwd, pack.key);
  const refused = new Set<string>();
  let values: Record<string, string>;
  try {
    values = await readProjectValues(cwd, pack.key, pack.settings ?? {}, (detail, name) => {
      errors.push(`${path}: ${detail}`);
      refused.add(name);
    });
  } catch (error) {
    if (!(error instanceof PackSettingsError)) throw error;
    errors.push(error.message);
    return errors;
  }
  for (const [name, spec] of Object.entries(pack.settings ?? {})) {
    if (spec.file !== true || refused.has(name)) continue;
    // An own-key lookup: a setting may be named `constructor`, which a plain object inherits.
    const value = Object.hasOwn(values, name) ? values[name] : spec.default;
    const problem = await fileSettingProblem(cwd, value);
    if (problem !== undefined) {
      errors.push(`${path}: setting '${name}' names file '${value}', which ${problem}`);
    }
  }
  return errors;
}

/** Why a file setting's value does not name a file; undefined when it does or is empty. */
async function fileSettingProblem(
  cwd: string,
  value: string | undefined
): Promise<string | undefined> {
  if (value === undefined || value === '') return undefined;
  // Joined, not resolved: normalizing would drop a trailing slash or fold `..` across a
  // symlink, so validate would check a different path than a stage opens.
  return fileProblem(isAbsolute(value) ? value : `${cwd}${sep}${value}`);
}

/** Why a file setting's resolved path is not a file, or undefined when it is one. */
async function fileProblem(resolved: string): Promise<string | undefined> {
  try {
    return (await stat(resolved)).isFile() ? undefined : `is not a file (${resolved})`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return `does not exist (${resolved})`;
    return `could not be read (${resolved}): ${(error as Error).message}`;
  }
}

function packSettingDefaults(pack: WorkflowPack | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, spec] of Object.entries(pack?.settings ?? {})) {
    if (spec.default !== undefined) values[name] = spec.default;
  }
  return values;
}

async function readProjectValues(
  cwd: string,
  packKey: string,
  declared: Readonly<Record<string, PackSettingSpec>>,
  reportSettingError?: (detail: string, name: string) => void
): Promise<Record<string, string>> {
  const path = projectPackSettingsPath(cwd, packKey);
  const fail = failIn(path);
  const report: (detail: string, name: string) => void = reportSettingError ?? fail;
  const text = await readOptionalFile(path, fail);
  const settings =
    text === undefined ? undefined : topLevelMappings(text, ['settings'], fail).settings;
  const known = Object.keys(declared).sort();
  const declaredList = known.length > 0 ? known.map(n => `'${n}'`).join(', ') : 'no settings';
  const values: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(settings ?? {})) {
    const spec = Object.hasOwn(declared, name) ? declared[name] : undefined;
    if (spec === undefined) {
      report(`unknown setting '${name}'; pack '${packKey}' declares ${declaredList}`, name);
      continue;
    }
    const checked = packSettingValue(spec, rawValue);
    if ('error' in checked) {
      report(`setting '${name}' ${checked.error}`, name);
      continue;
    }
    values[name] = checked.value;
  }
  return values;
}

/** What a fresh run starts with. */
export interface RunStartInputs {
  /** The run's `$INPUTS`; undefined when it has none. */
  inputs: Record<string, JsonValue> | undefined;
}

/**
 * Resolve a fresh run's inputs: its pack's settings, then the workflow's declared
 * defaults, then what the run was supplied with.
 *
 * @param supplied the values the run was invoked with (`--input`, a parent's `with:`).
 * @throws PackSettingsError on a bad project file or a `required` setting left unset.
 */
export async function resolveRunStartInputs(
  cwd: string,
  workflow: Pick<ResolvedWorkflow, 'pack' | 'inputs'>,
  supplied: Readonly<Record<string, JsonValue>> | undefined
): Promise<RunStartInputs> {
  const pack = workflow.pack;
  const projectValues = pack === undefined ? {} : await readProjectPackSettings(cwd, pack);
  const inputs: Record<string, JsonValue> = {
    ...packSettingDefaults(pack),
    ...defaultRunInputs(workflow.inputs),
    ...projectValues,
    ...supplied,
  };
  if (pack !== undefined) assertRequiredSettings(cwd, pack, inputs);
  return { inputs: Object.keys(inputs).length > 0 ? inputs : undefined };
}

/**
 * A `required` setting has no default of its own: the project file, a same-named workflow
 * input default, or a value supplied to the run must set it.
 */
function assertRequiredSettings(
  cwd: string,
  pack: WorkflowPack,
  values: Readonly<Record<string, unknown>>
): void {
  const missing = Object.entries(pack.settings ?? {})
    .filter(([name, spec]) => spec.required === true && !Object.hasOwn(values, name))
    .map(([name]) => `'${name}'`);
  if (missing.length === 0) return;
  const plural = missing.length === 1 ? '' : 's';
  throw new PackSettingsError(
    `${projectPackSettingsPath(cwd, pack.key)}: pack '${pack.key}' requires setting${plural} ${missing.join(', ')}; set ${missing.length === 1 ? 'it' : 'them'} under 'settings:' or pass --input.`
  );
}
