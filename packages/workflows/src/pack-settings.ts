/**
 * Pack settings: declared once by a pack, valued per project, resolved once per run.
 *
 *  - The DECLARATION is `<pack>/.pack/pack.yaml`, a top-level `inputs:` block in the
 *    workflow input-spec shape plus a `type`. It lives in a dot folder because neither
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
 * `workflow:` child, being a run of its own, reads its own. An `include:`d block takes
 * nothing from its pack; its includer passes what it needs through `with:`.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import { inputEnvKeyCollision } from './loader/workflow-fields';
import type { JsonValue } from './output-ref';
import { INPUT_NAME_PATTERN } from './schemas/node-bindings';
import type { ResolvedWorkflow } from './schemas';
import {
  packSettingSpecSchema,
  type PackSettingSpec,
  type WorkflowPack,
} from './schemas/pack-settings';
import { defaultRunInputs } from './workflow-inputs';

/** The declaration's path inside a pack directory. */
export const PACK_DECLARATION_PATH = join('.pack', 'pack.yaml');

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
    return { error: `must be a string (quote it in YAML), got ${JSON.stringify(raw)}` };
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
type Fail = (detail: string) => never;

function failIn(label: string): Fail {
  return detail => {
    throw new PackSettingsError(`${label}: ${detail}`);
  };
}

/**
 * The mapping under a file's one allowed top-level key, or undefined when the file or the
 * key is empty. Any other top-level key fails: an unknown key is a typo, not a no-op.
 */
function singleKeyMapping(
  text: string,
  key: string,
  fail: Fail
): Record<string, unknown> | undefined {
  let raw: unknown;
  try {
    raw = parseYamlText(text);
  } catch (error) {
    return fail(`not valid YAML: ${(error as Error).message}`);
  }
  if (raw === null || raw === undefined) return undefined;
  if (!isPlainObject(raw)) return fail(`must be a mapping with a '${key}:' key`);
  const unknown = Object.keys(raw).find(k => k !== key);
  if (unknown !== undefined)
    return fail(`unknown key '${unknown}'; this file holds only '${key}:'`);
  const inner = raw[key];
  if (inner === undefined || inner === null) return undefined;
  if (!isPlainObject(inner)) return fail(`'${key}' must be a mapping`);
  return inner;
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
  const { default: rawDefault, ...spec } = parsed.data;
  if (rawDefault === undefined) return spec;
  if (spec.required === true) {
    fail(`input '${name}' sets both 'required' and 'default'; a default makes it optional`);
  }
  const checked = packSettingValue(spec, rawDefault);
  if ('error' in checked) return fail(`input '${name}' default ${checked.error}`);
  return { ...spec, default: checked.value };
}

/**
 * Parse a pack declaration. Only a top-level `inputs:` map is accepted; each name follows
 * the input-name grammar, each spec the setting schema, and each default its own type.
 * Two names folding to one `INPUTS_*` key are refused here, where all are visible.
 *
 * @param label how errors name the file.
 * @throws PackSettingsError naming the file and the key.
 */
export function parsePackDeclaration(
  text: string,
  label: string
): Record<string, PackSettingSpec> | undefined {
  const fail = failIn(label);
  const inputs = singleKeyMapping(text, 'inputs', fail);
  if (inputs === undefined) return undefined;
  const settings = Object.fromEntries(
    Object.entries(inputs).map(([name, rawSpec]) => [name, parseSettingSpec(name, rawSpec, fail)])
  );
  const collision = inputEnvKeyCollision(Object.keys(settings));
  if (collision !== null) fail(collision);
  return Object.keys(settings).length > 0 ? settings : undefined;
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
): Promise<Record<string, PackSettingSpec> | undefined> {
  const fileLabel = `${label}/${PACK_DECLARATION_PATH.replaceAll('\\', '/')}`;
  const text = await readOptionalFile(join(packPath, PACK_DECLARATION_PATH), failIn(fileLabel));
  return text === undefined ? undefined : parsePackDeclaration(text, fileLabel);
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
  declared: Readonly<Record<string, PackSettingSpec>>
): Promise<Record<string, string>> {
  const path = projectPackSettingsPath(cwd, packKey);
  const fail = failIn(path);
  const text = await readOptionalFile(path, fail);
  const settings = text === undefined ? undefined : singleKeyMapping(text, 'settings', fail);
  const known = Object.keys(declared).sort();
  const declaredList = known.length > 0 ? known.map(n => `'${n}'`).join(', ') : 'no settings';
  const values: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(settings ?? {})) {
    const spec = Object.hasOwn(declared, name) ? declared[name] : undefined;
    if (spec === undefined) {
      return fail(`unknown setting '${name}'; pack '${packKey}' declares ${declaredList}`);
    }
    const checked = packSettingValue(spec, rawValue);
    if ('error' in checked) return fail(`setting '${name}' ${checked.error}`);
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
  workflow: ResolvedWorkflow,
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
