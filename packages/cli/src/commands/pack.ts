/**
 * `archon pack bindings <pack>`: write the trigger bindings a pack recommends as files for
 * one repository.
 *
 * The pack declares each binding once (`bindings:` in its `.pack/pack.yaml`); the operator
 * supplies the repository, the host, the run-as user and the checkout. The command only
 * writes files. It registers and schedules nothing: the operator still runs
 * `archon trigger fire` and `archon trigger schedule install` for a timer binding, and adds
 * an event binding to the source plugin's configuration.
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createForgeBindingSchema } from '@archon/forge';
import { jsonValueSchema } from '@archon/workflows/output-ref';
import { resourceStartBindingIntentSchema } from '@archon/workflows/schemas/resource-start';
import {
  isPackTimerBinding,
  type PackBinding,
  type PackBindingInput,
} from '@archon/workflows/schemas/pack-bindings';
import type { WorkflowSource } from '@archon/workflows/schemas/workflow';
import { writeJsonLine } from '../utils/stdout';
import { timerTriggerConfigSchema } from './trigger';
import { loadWorkflows } from './workflow-list';

export interface PackBindingsOptions {
  /** The checkout the bindings launch in, and where the pack is discovered from. */
  cwd: string;
  repo?: string;
  host?: string;
  runAs?: string;
  out?: string;
  only?: string;
  force?: boolean;
  json?: boolean;
}

const USAGE =
  'Usage: archon pack bindings <pack> --repo <host>/<owner>/<name> --host <host-id> --run-as <user-id> --out <dir> [--cwd <checkout>] [--only <id,...>] [--force]';

interface Target {
  packKey: string;
  repo: { host: string; path: string };
  /** The repository path as one file-name segment. */
  slug: string;
  hostId: string;
  runAsUserId: string;
  cwd: string;
  outDir: string;
}

interface Generated {
  id: string;
  kind: 'timer' | 'event';
  path: string;
  document: unknown;
}

function parseRepo(repo: string): Target['repo'] {
  const match = /^([A-Za-z0-9.-]+)\/([\w.-]+(?:\/[\w.-]+)+)$/.exec(repo);
  if (!match?.[1] || !match[2])
    throw new Error(`--repo must be <host>/<owner>/<name>, such as github.com/acme/widgets`);
  return { host: match[1], path: match[2] };
}

/** One name for a binding's file, its binding id and a timer's source instance. */
function bindingName(target: Target, id: string): string {
  return `${target.slug}-${id}`;
}

function bindingPath(target: Target, id: string): string {
  return join(target.outDir, `${bindingName(target, id)}.json`);
}

function generate(
  id: string,
  binding: PackBinding,
  workflowName: string,
  target: Target
): Generated {
  const literals: Record<string, string> = {};
  const fields: Record<string, { source: 'field'; field: string }> = {};
  const resolveInput = (name: string, input: PackBindingInput): void => {
    if (typeof input === 'string') literals[name] = input;
    else if ('repo' in input) literals[name] = target.repo[input.repo];
    else if ('binding' in input) literals[name] = bindingPath(target, input.binding);
    else fields[name] = { source: 'field', field: input.event };
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
      workflowName,
      inputs: literals,
      isolation: binding.isolation,
    },
  };
  const path = bindingPath(target, id);
  if (isPackTimerBinding(binding)) {
    return {
      id,
      kind: 'timer',
      path,
      document: {
        version: 1,
        sourceInstanceId: bindingName(target, id),
        binding: { ...intent, bindingRevision: null },
        schedule: { intervalSeconds: binding.schedule.interval_seconds, runAtLoad: false },
      },
    };
  }
  return {
    id,
    kind: 'event',
    path,
    document: {
      ...intent,
      selector: { ...binding.event, repository: target.repo },
      inputMapping: fields,
    },
  };
}

/** Check a generated document against the schema of the loader that will read it. */
/**
 * An event binding as a forge source plugin reads one: the start it asks for, and a
 * selector whose event fields its input mapping may name. The CLI may not bundle a source
 * plugin, so this checks the two contracts every such plugin builds on; the plugin still
 * validates its whole configuration, host and secret included, when it loads.
 */
const eventMappingSchema = createForgeBindingSchema(jsonValueSchema);
const eventBindingSchema = resourceStartBindingIntentSchema
  .omit({ bindingRevision: true, eventInputs: true })
  .passthrough()
  .superRefine((binding, context) => {
    const mapping = eventMappingSchema.safeParse({
      selector: binding.selector,
      inputs: binding.inputMapping,
    });
    if (mapping.success) return;
    for (const issue of mapping.error.issues) {
      context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    }
  });

function assertLoadable({ id, kind, document }: Generated): void {
  const result =
    kind === 'timer'
      ? timerTriggerConfigSchema.safeParse(document)
      : eventBindingSchema.safeParse(document);
  if (result.success) return;
  const reader = kind === 'timer' ? 'timer binding' : 'source plugin binding';
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

const SCOPE_PRECEDENCE: readonly WorkflowSource[] = ['project', 'global', 'bundled', 'installed'];

async function findPack(cwd: string, packKey: string): Promise<DeclaredPack> {
  const discovered = await loadWorkflows(cwd);
  const workflows = discovered.workflows.filter(entry => entry.workflow.pack?.key === packKey);
  if (workflows.length === 0) {
    // An invalid declaration fails every workflow of its pack, so the reason is here.
    const errors = [...new Set(discovered.errors.map(e => `  ${e.filename}: ${e.error}`))];
    throw new Error(
      [`No workflow pack '${packKey}' was found from ${cwd}.`, ...errors.slice(0, 20)].join('\n')
    );
  }
  // Pack folders of one name in several scopes are one pack to a run, and the nearest
  // scope's file wins there; the nearest declaration wins here.
  const bindings = SCOPE_PRECEDENCE.map(
    source => workflows.find(entry => entry.workflow.pack?.source === source)?.workflow.pack
  ).find(pack => pack?.bindings !== undefined)?.bindings;
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
  const name = pack.workflowNames.find(n => n === declared || n.endsWith(`:${declared}`));
  if (name === undefined)
    throw new Error(
      `Binding '${id}' names workflow '${declared}', which pack '${pack.key}' does not provide.`
    );
  return name;
}

function nextSteps(generated: readonly Generated[], target: Target): string[] {
  const lines: string[] = [];
  const timers = generated.filter(g => g.kind === 'timer');
  const events = generated.filter(g => g.kind === 'event');
  if (timers.length > 0) {
    lines.push(
      '',
      'Timer bindings. Fire each once to check it, then schedule it. `schedule install` is macOS launchd; elsewhere run the same `trigger fire` command from cron, systemd or Task Scheduler:'
    );
    for (const timer of timers) {
      lines.push(
        `  archon trigger fire --config ${timer.path}`,
        `  archon trigger schedule install --config ${timer.path}`
      );
    }
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
  const repo = parseRepo(options.repo);
  return {
    packKey,
    repo,
    slug: repo.path.replaceAll('/', '-'),
    hostId: options.host,
    runAsUserId: options.runAs,
    cwd: resolve(options.cwd),
    outDir: resolve(options.out),
  };
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

async function packBindings(packKey: string, options: PackBindingsOptions): Promise<void> {
  const target = targetFrom(packKey, options);
  const { repo } = target;
  const pack = await findPack(target.cwd, packKey);
  const ids = selectIds(pack, options.only);

  // Every binding is generated and checked before the first file is written.
  const generated: Generated[] = [];
  for (const id of ids) {
    const binding = pack.bindings[id];
    if (binding === undefined) continue;
    await assertSiblingFiles(id, binding, ids, target);
    const item = generate(id, binding, workflowNameFor(pack, id, binding.workflow), target);
    assertLoadable(item);
    generated.push(item);
  }
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
      written: generated.map(({ id, kind, path }) => ({ id, kind, path })),
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

export async function packCommand(
  subcommand: string | undefined,
  args: readonly string[],
  options: PackBindingsOptions
): Promise<void> {
  const [packKey] = args;
  if (subcommand !== 'bindings' || !packKey || args.length !== 1) throw new Error(USAGE);
  await packBindings(packKey, options);
}
