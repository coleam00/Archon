/**
 * The flags `archon trigger fire` reads before it records anything: the binding file it
 * describes, the event inputs it maps, the run config layer and tier/`@alias` rebindings its
 * starts run on, and the item they are on.
 *
 * Reading them here rather than inside the command keeps one thing owned by one place: a
 * typo in any of them fails the fire before a receipt exists, so a start is never recorded
 * with an input, a layer or a rebinding the operator did not mean.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from '@hono/zod-openapi';
import { jsonValueSchema } from '@archon/workflows/output-ref';
import { resourceStartBindingIntentSchema } from '@archon/workflows/schemas/resource-start';
import type { StartOverrides } from '@archon/workflows/schemas/start-overrides';
import { assertItemKey } from '@archon/workflows/schemas/workflow-run';
import { parseRunModelAssignments } from '@archon/workflows/model-validation';
import { loadWorkflowRunConfigFile } from '@archon/core/config/run-config';
import { parseInputAssignments } from '@archon/workflows/workflow-inputs';

/** The flags a fire reads, as the command's option bag carries them. */
export interface FireFlagOptions {
  /** The binding file a fire describes (`--binding`). */
  binding?: string;
  /** A run config layer for the starts a fire creates (`--config`). */
  config?: string;
  /** `--model <tier|@alias>=<model>`, repeatable, for the starts a fire creates. */
  model?: string[];
  deliveryId?: string;
  inputs?: string;
  input?: readonly string[];
  item?: string;
  noItem?: boolean;
  /** Give the start's item priority when the fire is first accepted. */
  priority?: boolean;
}

/**
 * The binding file a fire describes.
 *
 * `--binding` is the name. `--config` used to be, and an installed timer's job still spells it
 * that way, so a fire that gives `--config` alone reads it as the binding and says so once on
 * stderr: breaking every timer on upgrade is not worth the tidy name. A fire that gives both
 * means the new meaning of `--config` — a run config layer — and is not a timer.
 */
export function fireBindingFile(options: FireFlagOptions): string | undefined {
  if (options.binding !== undefined) return options.binding;
  if (options.config === undefined) return undefined;
  process.stderr.write(
    `Reading --config '${options.config}' as the binding file, as an installed timer writes it. Pass it as --binding; --config now names a run config layer.\n`
  );
  return options.config;
}

/**
 * The choices a fire makes for the starts it records: a config layer (`--config`) and
 * tier/`@alias` rebindings (`--model`). Both are read here — a typo fails the fire, not the
 * start it would have recorded a minute later — and stored as the operator typed them, so a
 * retry of that start needs no flags.
 *
 * A recorded delivery answers with the receipt it kept, so this call's flags cannot change
 * it: reading the layer for one would fail a retry whose layer file has since moved, for a
 * start already accepted. A `--config` that named the binding file is not also a layer
 * either; see `fireBindingFile`.
 */
export async function fireStartOverrides(
  options: FireFlagOptions,
  recorded: boolean
): Promise<StartOverrides | undefined> {
  if (recorded) return undefined;
  const models =
    options.model === undefined || options.model.length === 0
      ? undefined
      : parseRunModelAssignments(options.model);
  // Only when `--binding` named the file: otherwise `--config` is the binding, not a layer.
  const layerPath = options.binding === undefined ? undefined : options.config;
  const configPath = layerPath === undefined ? undefined : resolve(layerPath);
  if (configPath !== undefined) await loadWorkflowRunConfigFile(configPath);
  if (configPath === undefined && models === undefined) return undefined;
  return {
    ...(configPath === undefined ? {} : { config: { path: configPath } }),
    ...(models === undefined ? {} : { models }),
  };
}

/** `--item` names one item and `--no-item` refuses one; both together are refused. */
export function assertItemOptions(options: FireFlagOptions): void {
  if (options.item === undefined) return;
  if (options.noItem) throw new Error('--item and --no-item are mutually exclusive.');
  assertItemKey(options.item);
}

/**
 * A fire's event inputs: the `--inputs` JSON file and each `--input name=value`, in the
 * grammar `workflow run --input` speaks, so their values are text. A name given by both is
 * refused rather than merged, as `workflow run` refuses one given by `--input` and
 * `--input-file`. Neither flag reads as undefined, not `{}`, so a fire without inputs
 * records the intent it always has and a redelivery of it still replays.
 *
 * @throws on an unreadable or invalid file, a malformed assignment, or a name given twice.
 */
export async function readEventInputs(
  options: Pick<FireFlagOptions, 'inputs' | 'input'>
): Promise<z.infer<typeof resourceStartBindingIntentSchema>['eventInputs']> {
  let fromFile: z.infer<typeof resourceStartBindingIntentSchema>['eventInputs'];
  if (options.inputs !== undefined) {
    try {
      fromFile = z
        .record(z.string().min(1), jsonValueSchema)
        .parse(JSON.parse(await readFile(options.inputs, 'utf8')) as unknown);
    } catch (error) {
      throw new Error(
        '--inputs must name a readable file containing a JSON object with non-empty input names.',
        { cause: error }
      );
    }
  }
  if (!options.input?.length) return fromFile;
  const assigned = parseInputAssignments(options.input);
  for (const name of Object.keys(assigned))
    if (fromFile && Object.hasOwn(fromFile, name))
      throw new Error(`Input '${name}' is given by both --inputs and --input: supply it once.`);
  return { ...fromFile, ...assigned };
}
