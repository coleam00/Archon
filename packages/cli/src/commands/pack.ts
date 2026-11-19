/**
 * `archon pack graph <pack>`: the pack's stage graph in this install (`readPackGraph`).
 *
 * `archon pack bindings <pack>`: write the trigger bindings a pack recommends as files for
 * one repository.
 *
 * The pack declares each binding once (`bindings:` in its `.pack/pack.yaml`); the operator
 * supplies the repository, the host, the run-as user and the checkout, and optionally the
 * default run config of their starts (an item in flight keeps its own) and where the pack's workflows are discovered.
 *
 * Every file goes to `--out` and nothing registers it: the operator still runs
 * `archon trigger fire` and `archon trigger schedule install` for a timer binding, adds an
 * event binding to the source plugin's configuration, and copies a run-ended or
 * asks-settled file into the triggers directory, where the engine reads it. A fire-only
 * file is what a run or an operator passes to `archon trigger fire`.
 *
 * One invalid run-ended or asks-settled file in the triggers directory fails item runs on
 * the whole install, so every such file is checked as `archon trigger check` checks it
 * before anything is written.
 */
import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { githubWebhookSourceConfigSchema } from '@archon/adapters/forge/github/source-config';
import { loadConfig } from '@archon/core/config/config-loader';
import { loadWorkflowRunConfigFile } from '@archon/core/config/run-config';
import { loadStoreSelection } from '@archon/core/config/store-selection';
import * as codebaseDb from '@archon/core/db/codebases';
import { registeredProjectKeyForPath } from '@archon/core/services/codebase-checkout-resolver';
import { readPackGraph } from '@archon/core/workflows/pack-graph';
import { asksSettledTriggerCheck } from '@archon/core/workflows/asks-settled';
import {
  type AsksSettledBinding,
  getTriggersPath,
  launchProjectKey,
  type OnBinding,
  type RunEndedBinding,
  runEndedTriggerCheck,
} from '@archon/core/workflows/run-ended';
import { providerRegistry } from '@archon/providers';
import { FileStoreUnsupportedError } from '@archon/workflows/file-store';
import {
  type KindedPackBinding,
  kindedPackBinding,
  type PackBinding,
  type PackBindingInput,
  type PackEventBinding,
  type PackBindingKind,
} from '@archon/workflows/schemas/pack-bindings';
import {
  nearestPackBindings,
  type PackGraph,
  packWorkflowName,
  packWorkflows,
} from '@archon/workflows/pack-graph';
import { writeJsonLine } from '../utils/stdout';
import {
  triggerConfigSchema,
  type AsksSettledInputSource,
} from '@archon/workflows/schemas/resource-start';
import { loadWorkflows } from './workflow-list';

export interface PackBindingsOptions {
  /** The checkout the bindings launch in, and where the pack is discovered from. */
  cwd: string;
  repo?: string;
  host?: string;
  runAs?: string;
  out?: string;
  /**
   * The default run config of the written bindings' starts (`launch.configSource`). A start
   * on an item whose latest run recorded a config carries that one instead.
   */
  config?: string;
  /** Where the pack's workflows are discovered when it does not live in the checkout. */
  workflowSource?: string;
  only?: string;
  force?: boolean;
  json?: boolean;
}

const USAGE =
  'Usage: archon pack bindings <pack> --repo <host>/<owner>/<name> --host <host-id> --run-as <user-id> --out <dir> [--cwd <checkout>] [--config <file>] [--workflow-source <dir>] [--only <id,...>] [--force]';

interface Target {
  packKey: string;
  repo: { host: string; path: string };
  hostId: string;
  runAsUserId: string;
  cwd: string;
  outDir: string;
  configSource?: string;
  discoveryCwd?: string;
}

interface Generated {
  id: string;
  kind: PackBindingKind;
  path: string;
  document: unknown;
  /** The outcome a run-ended file starts on; one file per outcome. */
  outcome?: string;
  /** The option an asks-settled file starts on; one file per option, when it names any. */
  option?: string;
}

function parseRepo(repo: string): Target['repo'] {
  const match = /^([A-Za-z0-9.-]+)\/([\w.-]+(?:\/[\w.-]+)+)$/.exec(repo);
  if (!match?.[1] || !match[2])
    throw new Error(`--repo must be <host>/<owner>/<name>, such as github.com/acme/widgets`);
  return { host: match[1], path: match[2] };
}

/**
 * One name for a binding's file, its binding id and its source instance. The readable
 * part flattens the repository path, so `a-b/c` and `a/b-c` read alike; the digest of the
 * whole identity keeps distinct packs, hosts, repositories and values apart. `value` is
 * the outcome or option a file starts on, for a binding written as one file per value.
 */
function bindingName(target: Target, id: string, value?: string): string {
  const { packKey, repo } = target;
  const identity = [packKey, repo.host, repo.path, id, ...(value === undefined ? [] : [value])];
  const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 12);
  const slug = value
    ?.toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');
  const readable = [packKey, repo.path.replaceAll('/', '-'), id, ...(slug ? [slug] : [])];
  return `${readable.join('-')}-${digest}`;
}

function bindingPath(target: Target, id: string, value?: string): string {
  return join(target.outDir, `${bindingName(target, id, value)}.json`);
}

/**
 * The trigger files a run-ended or asks-settled binding is written as: one per outcome for
 * a run-ended binding, and for an asks-settled binding one per option, or one when it names
 * no option, under the name it had before options existed.
 */
function onFiles(
  id: string,
  kinded: Extract<KindedPackBinding, { kind: 'asks_settled' | 'run_ended' }>,
  pack: DeclaredPack,
  target: Target,
  intent: Record<string, unknown>,
  fromRun: Record<string, AsksSettledInputSource>
): Generated[] {
  const mapped = Object.keys(fromRun).length > 0 ? { inputs: fromRun } : {};
  const file = (name: string, on: Record<string, unknown>) => ({
    version: 1,
    sourceInstanceId: name,
    binding: { ...intent, bindingId: name, bindingRevision: null },
    on,
  });
  if (kinded.kind === 'asks_settled') {
    const { workflow, settled, option, checkout } = kinded.binding.asks_settled;
    const workflowName = workflowNameFor(pack, id, workflow);
    const options =
      option === undefined ? [undefined] : typeof option === 'string' ? [option] : option;
    return options.map(value => {
      const asksSettled = {
        workflowName,
        settled,
        ...(value === undefined ? {} : { option: value }),
        ...(checkout === undefined ? {} : { checkout }),
        ...mapped,
      };
      return {
        id,
        kind: kinded.kind,
        path: bindingPath(target, id, value),
        ...(value === undefined ? {} : { option: value }),
        document: file(bindingName(target, id, value), { asksSettled }),
      };
    });
  }
  const { workflow, outcome, checkout } = kinded.binding.run_ended;
  const workflowName = workflowNameFor(pack, id, workflow);
  return (typeof outcome === 'string' ? [outcome] : outcome).map(value => {
    const runEnded = {
      workflowName,
      outcome: value,
      ...(checkout === undefined ? {} : { checkout }),
      ...mapped,
    };
    return {
      id,
      kind: kinded.kind,
      path: bindingPath(target, id, value),
      outcome: value,
      document: file(bindingName(target, id, value), { runEnded }),
    };
  });
}

function generate(
  id: string,
  binding: PackBinding,
  pack: DeclaredPack,
  target: Target
): Generated[] {
  const literals: Record<string, string> = {};
  const fields: Record<string, { source: 'field'; field: string }> = {};
  const fromRun: Record<string, AsksSettledInputSource> = {};
  let waitInput: string | undefined;
  const resolveInput = (name: string, input: PackBindingInput): void => {
    if (typeof input === 'string') literals[name] = input;
    else if ('repo' in input) literals[name] = target.repo[input.repo];
    else if ('binding' in input) literals[name] = bindingPath(target, input.binding);
    else if ('event' in input) fields[name] = { source: 'field', field: input.event };
    else if ('wait' in input) waitInput = name;
    else fromRun[name] = input;
  };
  for (const [name, input] of Object.entries(binding.inputs)) resolveInput(name, input);

  const scope =
    binding.resource_scope === 'host' ? target.hostId : `${target.repo.host}/${target.repo.path}`;
  const intent = {
    bindingId: bindingName(target, id),
    hostId: target.hostId,
    runAsUserId: target.runAsUserId,
    resource: `${target.packKey}:${scope}:${binding.resource}`,
    capacity: binding.capacity,
    overlap: binding.overlap,
    launch: {
      cwd: target.cwd,
      workflowName: workflowNameFor(pack, id, binding.workflow),
      inputs: literals,
      ...(target.discoveryCwd === undefined ? {} : { discoveryCwd: target.discoveryCwd }),
      ...(target.configSource === undefined ? {} : { configSource: target.configSource }),
      isolation: binding.isolation,
    },
  };
  const kinded = kindedPackBinding(binding);
  if (kinded.kind === 'asks_settled' || kinded.kind === 'run_ended')
    return onFiles(id, kinded, pack, target, intent, fromRun);
  const path = bindingPath(target, id);
  // A timer and a fire-only binding are the same `trigger fire --config` file; only the
  // timer carries a schedule.
  const fireConfig = {
    version: 1,
    sourceInstanceId: bindingName(target, id),
    binding: { ...intent, bindingRevision: null },
  };
  switch (kinded.kind) {
    case 'fire':
      return [
        {
          id,
          kind: kinded.kind,
          path,
          document: {
            ...fireConfig,
            ...(kinded.binding.item ? { item: kinded.binding.item } : {}),
          },
        },
      ];
    case 'timer':
      return [
        {
          id,
          kind: kinded.kind,
          path,
          document: {
            ...fireConfig,
            schedule: {
              intervalSeconds: kinded.binding.schedule.interval_seconds,
              runAtLoad: false,
            },
          },
        },
      ];
    case 'event':
      return [
        {
          id,
          kind: kinded.kind,
          path,
          document: {
            ...intent,
            selector: { ...kinded.binding.event, repository: target.repo },
            inputMapping: fields,
            ...(kinded.binding.item ? { item: kinded.binding.item } : {}),
            ...(kinded.binding.trustedText ? { trustedText: kinded.binding.trustedText } : {}),
            ...wakeDocument(kinded.binding.wake, pack, id, waitInput),
          },
        },
      ];
  }
}

/** The plugin's `wake` for a binding that declares one, with its workflow's installed name. */
function wakeDocument(
  wake: PackEventBinding['wake'],
  pack: DeclaredPack,
  id: string,
  input: string | undefined
): Record<string, unknown> {
  if (wake === undefined) return {};
  return {
    wake: {
      workflow: workflowNameFor(pack, id, wake.workflow),
      wait: wake.wait,
      about: { field: wake.about },
      ...(input === undefined ? {} : { input }),
    },
  };
}

/**
 * Check a generated document against the schema of the loader that will read it, and
 * return the binding a run-ended or asks-settled file holds, as the engine reads it.
 */
function assertLoadable(
  { id, kind, path, document }: Generated,
  target: Target
): OnBinding | undefined {
  const result =
    kind !== 'event'
      ? triggerConfigSchema.safeParse(document)
      : // The plugin reads a binding only inside its configuration, so the binding is checked
        // there. The secret name is the operator's and is not part of what is written.
        githubWebhookSourceConfigSchema.safeParse({
          version: 1,
          webhookSecretEnv: 'WEBHOOK_SECRET',
          host: target.repo.host,
          bindings: [document],
        });
  if (result.success) {
    if (!('on' in result.data)) return undefined;
    const { sourceInstanceId, binding, on } = result.data;
    if (on?.runEnded !== undefined)
      return { file: path, sourceInstanceId, binding, runEnded: on.runEnded };
    if (on?.asksSettled !== undefined)
      return { file: path, sourceInstanceId, binding, asksSettled: on.asksSettled };
    return undefined;
  }
  const reader = kind === 'event' ? 'GitHub source plugin binding' : 'trigger file';
  const issues = result.error.issues
    .map(issue => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new Error(`Binding '${id}' does not generate a valid ${reader} (${issues}).`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

interface DeclaredPack {
  key: string;
  bindings: Readonly<Record<string, PackBinding>>;
  /** The pack's dispatchable workflow names, as a binding must spell them. */
  workflowNames: readonly string[];
}

async function findPack(cwd: string, packKey: string): Promise<DeclaredPack> {
  const workflows = packWorkflows(await loadWorkflows(cwd), packKey, cwd);
  const bindings = nearestPackBindings(workflows);
  if (bindings === undefined)
    throw new Error(`Pack '${packKey}' declares no bindings in its .pack/pack.yaml.`);
  return {
    key: packKey,
    bindings,
    workflowNames: workflows.map(entry => entry.workflow.name),
  };
}

function selectIds(pack: DeclaredPack, only: string | undefined): string[] {
  const declared = Object.keys(pack.bindings);
  if (only === undefined) return declared;
  const ids = only.split(',').map(id => id.trim());
  const unknown = ids.filter(id => !Object.hasOwn(pack.bindings, id));
  if (unknown.length > 0)
    throw new Error(
      `--only names ${unknown.map(id => `'${id}'`).join(', ')}, which pack '${pack.key}' does not declare. It declares: ${declared.join(', ')}.`
    );
  return [...new Set(ids)];
}

/** An installed pack's workflow is named `owner/plugin:<name>`; a binding must use that name. */
function workflowNameFor(pack: DeclaredPack, id: string, declared: string): string {
  const name = packWorkflowName(pack.workflowNames, declared);
  if (name === undefined)
    throw new Error(
      `Binding '${id}' names workflow '${declared}', which pack '${pack.key}' does not provide.`
    );
  return name;
}

/** A POSIX shell word for a path the operator chose, which may hold spaces or quotes. */
function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** How to register files the engine reads from the triggers directory. */
function triggerAddSteps(files: readonly Generated[], heading: string, starts: string): string[] {
  if (files.length === 0) return [];
  return [
    '',
    `${heading}. Add each to the triggers directory, where it is active at once: it starts its workflow ${starts}. Then list and check them with \`archon trigger check\`; deleting one from the triggers directory turns it off:`,
    ...files.map(
      item =>
        `  archon trigger add ${shellQuote(item.path)}${item.outcome !== undefined ? `  # outcome '${item.outcome}'` : item.option !== undefined ? `  # option '${item.option}'` : ''}`
    ),
  ];
}

function nextSteps(generated: readonly Generated[], target: Target): string[] {
  const lines = [
    ...triggerAddSteps(
      generated.filter(g => g.kind === 'run_ended'),
      'Run-ended bindings',
      'when a run on an item ends with its outcome'
    ),
    ...triggerAddSteps(
      generated.filter(g => g.kind === 'asks_settled'),
      'Asks-settled bindings',
      'when the asks a run left on an item are settled'
    ),
  ];
  const timers = generated.filter(g => g.kind === 'timer');
  const events = generated.filter(g => g.kind === 'event');
  if (timers.length > 0) {
    lines.push(
      '',
      'Timer bindings. Fire each once to check it, then schedule it. `schedule install` is macOS launchd; elsewhere run the same `trigger fire` command from cron, systemd or Task Scheduler:'
    );
    for (const timer of timers) {
      lines.push(
        `  archon trigger fire --config ${shellQuote(timer.path)}`,
        `  archon trigger schedule install --config ${shellQuote(timer.path)}`
      );
    }
  }
  const fires = generated.filter(g => g.kind === 'fire');
  if (fires.length > 0) {
    lines.push(
      '',
      'Fire-only bindings. Nothing schedules these; a run or an operator starts each with:'
    );
    for (const fire of fires) lines.push(`  archon trigger fire --config ${shellQuote(fire.path)}`);
  }
  if (events.length > 0) {
    lines.push(
      '',
      `Event bindings. Add each file's object to "bindings" in the GitHub source plugin's "config", in the file ARCHON_WEBHOOK_SOURCES names, and start the server with ARCHON_TRIGGER_HOST=${target.hostId}:`
    );
    for (const event of events) lines.push(`  ${event.path}`);
  }
  return lines;
}

function targetFrom(packKey: string, options: PackBindingsOptions): Target {
  if (!options.repo || !options.host || !options.runAs || !options.out) throw new Error(USAGE);
  const absolute = (path: string | undefined): string | undefined =>
    path === undefined ? undefined : resolve(path);
  return {
    packKey,
    repo: parseRepo(options.repo),
    hostId: options.host,
    runAsUserId: options.runAs,
    cwd: resolve(options.cwd),
    outDir: resolve(options.out),
    configSource: absolute(options.config),
    discoveryCwd: absolute(options.workflowSource),
  };
}

/**
 * Check every run-ended file as `archon trigger check` checks it before any is written: a
 * file that fails a run's preflight would fail every item run of its ended workflow once the
 * operator copies it into the triggers directory, and one that never starts or loops is
 * refused with it.
 */
async function assertRunEndedChecks(
  ended: readonly { id: string; check: RunEndedBinding }[]
): Promise<void> {
  if (ended.length === 0) return;
  // The file store has no items, so a run-ended binding can never start anything there.
  if ((await loadStoreSelection()) === 'files')
    throw new FileStoreUnsupportedError(
      `Run-ended bindings (${[...new Set(ended.map(item => item.id))].join(', ')})`
    );
  const found = await runEndedTriggerCheck(
    ended.map(item => item.check),
    // Without the install's codebase records each checkout counts as its own project, so a
    // duplicate of a file already installed, or one in another checkout of the project, is
    // left to `archon trigger check`.
    { loadConfig, providers: providerRegistry, projectKeyOf: async () => null }
  );
  const problems = ended.flatMap(({ id, check }, index) =>
    found[index].map(
      problem => `  Binding '${id}' (outcome '${check.runEnded.outcome}'): ${problem}`
    )
  );
  if (problems.length > 0)
    throw new Error(
      ['Run-ended bindings have problems:', ...problems, 'Nothing was written.'].join('\n')
    );
}

/** The same check for every asks-settled file, as `archon trigger check` checks it. */
async function assertAsksSettledChecks(
  asks: readonly { id: string; check: AsksSettledBinding }[]
): Promise<void> {
  if (asks.length === 0) return;
  // The file store has no items or asks, so an asks-settled binding never starts there.
  if ((await loadStoreSelection()) === 'files')
    throw new FileStoreUnsupportedError(
      `Asks-settled bindings (${asks.map(item => item.id).join(', ')})`
    );
  const found = await asksSettledTriggerCheck(
    asks.map(item => item.check),
    // As for run-ended bindings, a duplicate among installed files is left to `trigger check`.
    { loadConfig, providers: providerRegistry, projectKeyOf: async () => null }
  );
  const problems = asks.flatMap(({ id, check }, index) =>
    found[index].map(
      problem =>
        `  Binding '${id}'${check.asksSettled.option === undefined ? '' : ` (option '${check.asksSettled.option}')`}: ${problem}`
    )
  );
  if (problems.length > 0)
    throw new Error(
      ['Asks-settled bindings have problems:', ...problems, 'Nothing was written.'].join('\n')
    );
}

/**
 * A sibling reference is written as a file path. A path to a file that is not there would
 * make the run's follow-up start fail later, far from this choice, so it is refused here.
 */
async function assertSiblingFiles(
  id: string,
  binding: PackBinding,
  selected: readonly string[],
  target: Target
): Promise<void> {
  for (const [name, input] of Object.entries(binding.inputs)) {
    if (typeof input === 'string' || !('binding' in input)) continue;
    const path = bindingPath(target, input.binding);
    if (selected.includes(input.binding) || (await exists(path))) continue;
    throw new Error(
      `Binding '${id}' input '${name}' names binding '${input.binding}', which --only leaves out and ${path} does not hold. Add '${input.binding}' to --only.`
    );
  }
}

async function assertNothingOverwritten(generated: readonly Generated[]): Promise<void> {
  const present: string[] = [];
  for (const item of generated) if (await exists(item.path)) present.push(item.path);
  if (present.length === 0) return;
  throw new Error(
    `Refusing to overwrite ${present.join(', ')}. Nothing was written. Pass --force to replace ${present.length === 1 ? 'it' : 'them'}.`
  );
}

/** Every selected binding, generated and checked before the first file is written. */
async function generateChecked(
  pack: DeclaredPack,
  ids: readonly string[],
  target: Target
): Promise<Generated[]> {
  const generated: Generated[] = [];
  const ended: { id: string; check: RunEndedBinding }[] = [];
  const asks: { id: string; check: AsksSettledBinding }[] = [];
  for (const id of ids) {
    const binding = pack.bindings[id];
    if (binding === undefined) continue;
    await assertSiblingFiles(id, binding, ids, target);
    for (const item of generate(id, binding, pack, target)) {
      const check = assertLoadable(item, target);
      if (check !== undefined && 'runEnded' in check) ended.push({ id, check });
      if (check !== undefined && 'asksSettled' in check) asks.push({ id, check });
      generated.push(item);
    }
  }
  await assertRunEndedChecks(ended);
  await assertAsksSettledChecks(asks);
  return generated;
}

async function packBindings(packKey: string, options: PackBindingsOptions): Promise<void> {
  const target = targetFrom(packKey, options);
  const { repo } = target;
  // A bad run config path fails here, not at the first start that loads it.
  if (target.configSource !== undefined) await loadWorkflowRunConfigFile(target.configSource);
  const pack = await findPack(target.discoveryCwd ?? target.cwd, packKey);
  const generated = await generateChecked(pack, selectIds(pack, options.only), target);
  if (!options.force) await assertNothingOverwritten(generated);

  await mkdir(target.outDir, { recursive: true });
  for (const item of generated) {
    // `wx` never replaces a file that appeared after the check above.
    await writeFile(item.path, `${JSON.stringify(item.document, null, 2)}\n`, {
      flag: options.force ? 'w' : 'wx',
    });
  }

  if (options.json) {
    await writeJsonLine({
      pack: packKey,
      written: generated.map(({ id, kind, path, outcome, option }) => ({
        id,
        kind,
        path,
        ...(outcome === undefined ? {} : { outcome }),
        ...(option === undefined ? {} : { option }),
      })),
    });
    return;
  }
  console.log(
    [
      `Wrote ${generated.length} binding file${generated.length === 1 ? '' : 's'} for ${repo.host}/${repo.path} to ${target.outDir}. Nothing is registered or scheduled yet.`,
      ...nextSteps(generated, target),
    ].join('\n')
  );
}

const GRAPH_USAGE =
  'Usage: archon pack graph <pack> [--cwd <checkout>] [--workflow-source <dir>] [--json]';

function arrowText(arrow: PackGraph['arrows'][number]): string {
  const problems = arrow.active ? arrow.installed.problems : [];
  const state = !arrow.active
    ? 'declared, inactive'
    : problems.length > 0
      ? `active, refused: ${problems.join('; ')}`
      : 'active';
  const declared = arrow.declared?.problems ?? [];
  const note = declared.length > 0 ? ` (binding ${declared.join('; ')})` : '';
  const from =
    'outcome' in arrow.from
      ? `${arrow.from.stage}:${arrow.from.outcome}`
      : `${arrow.from.stage}:asks(${arrow.from.settled}${arrow.from.option === undefined ? '' : `: ${arrow.from.option}`})`;
  return `  ${from} -> ${arrow.to} [${state}]${note}`;
}

/** The graph as plain lines; `--json` prints the read itself, which is the contract. */
function graphText(graph: PackGraph): string {
  const lines = [`Pack '${graph.pack}': ${String(graph.stages.length)} stage(s)`];
  for (const stage of graph.stages) {
    const values = stage.outcome?.values.map(v => v.value).join(', ');
    lines.push(`  ${stage.name}${values === undefined ? ' (no outcome)' : `: ${values}`}`);
  }
  lines.push('', `Arrows: ${String(graph.arrows.length)}`);
  for (const arrow of graph.arrows) lines.push(arrowText(arrow));
  const nothing = graph.stages.flatMap(stage =>
    (stage.outcome?.values ?? [])
      .filter(v => v.startsNothing)
      .map(v => `  ${stage.name}:${v.value}${stage.asks ? '' : ' (no asks: ends in silence)'}`)
  );
  if (nothing.length > 0) lines.push('', 'Outcomes that start nothing:', ...nothing);
  if (graph.discoveryErrors.length > 0)
    lines.push(
      '',
      'Workflows that failed to load (a stage among them is missing above):',
      ...graph.discoveryErrors.map(e => `  ${e.filename}: ${e.error}`)
    );
  return lines.join('\n');
}

async function packGraph(packKey: string, options: PackBindingsOptions): Promise<void> {
  const graph = await readPackGraph(
    resolve(options.cwd),
    packKey,
    {
      loadConfig,
      providers: providerRegistry,
      triggersDirectory: getTriggersPath,
      projectKeyOf: launchProjectKey(cwd => registeredProjectKeyForPath(cwd, codebaseDb)),
    },
    options.workflowSource === undefined ? {} : { workflowSource: resolve(options.workflowSource) }
  );
  if (options.json) await writeJsonLine(graph);
  else console.log(graphText(graph));
}

export async function packCommand(
  subcommand: string | undefined,
  args: readonly string[],
  options: PackBindingsOptions
): Promise<void> {
  const [packKey] = args;
  if (subcommand === 'graph') {
    if (!packKey || args.length !== 1) throw new Error(GRAPH_USAGE);
    await packGraph(packKey, options);
    return;
  }
  if (subcommand !== 'bindings' || !packKey || args.length !== 1) throw new Error(USAGE);
  await packBindings(packKey, options);
}
