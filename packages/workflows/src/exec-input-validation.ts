import type { DagNode, ExecNode, WorkflowDefinition } from './schemas';
import { inputEnvKey, isExecNode, isIncludeDirective } from './schemas';
import { EXEC_NODE_ENVIRONMENT_NAMES } from './exec-environment';
import { readComposedMeta } from './compiled-command';
import { isInlineScript } from './executor-shared';
import type { TemplateSlot } from './template-walker';
import { visitNodeTemplateSlots } from './template-walker';

const INPUT_ENV_PREFIX = inputEnvKey('');

export interface ExecInputValidationTarget {
  readonly node: ExecNode;
  readonly slot: TemplateSlot;
  readonly bindingNames: readonly string[];
}

export interface ExecInputSource {
  readonly text: string;
  readonly label: string;
  readonly runtime: ExecNode['runtime'];
}

export interface ExecInputValidationResult {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

interface MutableTarget {
  node: ExecNode;
  slot: TemplateSlot;
  bindingNames: Set<string>;
}

interface EnvironmentRead {
  name: string;
  offset: number;
  line: number;
}

export function collectExecInputValidationTargets(
  workflow: WorkflowDefinition
): readonly ExecInputValidationTarget[] {
  const targets = new Map<ExecNode, MutableTarget>();

  for (const node of workflow.nodes) {
    if (isIncludeDirective(node)) continue;
    visitNodeTemplateSlots(
      node,
      slot => {
        if (slot.name !== 'exec.bash' && slot.name !== 'exec.script') return;
        if (!isExecNode(slot.owner)) return;
        targets.set(slot.owner, { node: slot.owner, slot, bindingNames: new Set() });
      },
      {
        bindingVisitor: binding => {
          if (isExecNode(binding.owner)) targets.get(binding.owner)?.bindingNames.add(binding.name);
        },
      }
    );
  }

  return [...targets.values()].map(target => ({
    node: target.node,
    slot: target.slot,
    bindingNames: [...target.bindingNames],
  }));
}

export function inlineExecInputSource(
  target: ExecInputValidationTarget
): ExecInputSource | undefined {
  if (target.slot.name === 'exec.bash') {
    return { text: target.slot.value, label: 'bash', runtime: 'sh' };
  }
  if (!isInlineScript(target.slot.value)) return undefined;
  return { text: target.slot.value, label: 'script', runtime: target.node.runtime };
}

function describeUnavailableEnvironmentRead(
  target: ExecInputValidationTarget,
  source: ExecInputSource,
  read: EnvironmentRead,
  availableNames: readonly string[],
  isInputsRead: boolean
): string {
  const location = `${source.label} line ${String(read.line)}`;
  const available =
    availableNames.length === 0 ? 'none' : availableNames.map(name => `'${name}'`).join(', ');

  if (isInputsRead) {
    const prefix =
      `Node '${target.node.id}' ${target.slot.path} (${location}) reads environment variable ` +
      `'${read.name}', which is not provided by its bindings, declared inputs, or the engine. ` +
      `Available bindings/inputs: ${available}.`;
    const fix =
      target.node.runtime === 'sh'
        ? ` Declare a workflow input that maps to '${read.name}'; bash nodes do not support node-local 'with:' bindings.`
        : ` Add a matching 'with:' binding or declare a workflow input that maps to '${read.name}'.`;
    return prefix + fix;
  }
  return (
    `Node '${target.node.id}' ${target.slot.path} (${location}) reads environment variable ` +
    `'${read.name}', which is not provided by its bindings, declared inputs, the engine, ` +
    '.archon/.env, or a configured env var. It might come from a source this check ' +
    'cannot see at validate time — for example, a codebase env var configured in the ' +
    `database — or it might be a typo. Available bindings/inputs: ${available}.`
  );
}

function validateTargetEnvironmentReads(
  workflow: Pick<WorkflowDefinition, 'inputs' | 'pack'>,
  target: ExecInputValidationTarget,
  source: ExecInputSource,
  declaredInputs: readonly string[],
  configuredEnvNames: ReadonlySet<string>
): ExecInputValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const availableNames = [...new Set([...target.bindingNames, ...declaredInputs])].sort();
  const availableEnv = new Set(EXEC_NODE_ENVIRONMENT_NAMES);
  for (const name of availableNames) availableEnv.add(inputEnvKey(name));

  for (const read of scanEnvironmentReads(source.text, source.runtime)) {
    if (availableEnv.has(read.name)) continue;
    const isInputsRead = read.name.startsWith(INPUT_ENV_PREFIX);
    if (isInputsRead && workflow.inputs === undefined) continue;
    if (configuredEnvNames.has(read.name)) continue;
    const diagnostic = describeUnavailableEnvironmentRead(
      target,
      source,
      read,
      availableNames,
      isInputsRead
    );
    if (isInputsRead) errors.push(diagnostic);
    else warnings.push(diagnostic);
  }
  return { errors, warnings };
}

export function validateExecInputTargets(
  workflow: Pick<WorkflowDefinition, 'inputs' | 'pack'>,
  targets: readonly ExecInputValidationTarget[],
  resolveSource: (target: ExecInputValidationTarget) => ExecInputSource | undefined,
  configuredEnvNames: ReadonlySet<string> = new Set()
): ExecInputValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  // A pack setting reaches every node of the pack's workflows as an input when the
  // workflow runs directly. Included, the block reads only what its includer passes:
  // `findUnpassedPackSettingReads` checks that at include expansion.
  const declaredInputs = [
    ...new Set([
      ...Object.keys(workflow.inputs ?? {}),
      ...Object.keys(workflow.pack?.settings ?? {}),
    ]),
  ];

  for (const target of targets) {
    const source = resolveSource(target);
    if (source === undefined) continue;

    const result = validateTargetEnvironmentReads(
      workflow,
      target,
      source,
      declaredInputs,
      configuredEnvNames
    );
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  return { errors, warnings };
}

export function validateInlineExecInputs(
  workflow: WorkflowDefinition,
  configuredEnvNames?: ReadonlySet<string>
): ExecInputValidationResult {
  return validateExecInputTargets(
    workflow,
    collectExecInputValidationTargets(workflow),
    inlineExecInputSource,
    configuredEnvNames
  );
}

/** A raw `INPUTS_<NAME>` read of a pack setting that nothing passes to the included node. */
export interface UnpassedPackSettingRead {
  readonly nodeId: string;
  readonly path: string;
  readonly location: string;
  readonly envName: string;
  readonly setting: string;
}

/**
 * Raw `INPUTS_<NAME>` reads, in an included block's own nodes, of the block's pack
 * settings that neither the includer (`passed`) nor the node's own `with:` supplies.
 * At run time such a read gets the INCLUDING run's value, so it is refused at load like
 * the `$INPUTS.<name>` form. Nodes that arrived through a deeper include carry composed
 * metadata and were checked against their own file when that include was expanded.
 * A named script with no source in `namedScripts` (a flat name discovery did not
 * resolve) cannot be read here and is not checked.
 */
export function findUnpassedPackSettingReads(
  nodes: readonly DagNode[],
  settingNames: readonly string[],
  passed: (name: string) => boolean,
  namedScripts: ReadonlyMap<string, ExecInputSource>
): readonly UnpassedPackSettingRead[] {
  const settingByEnv = new Map(settingNames.map(name => [inputEnvKey(name), name]));
  const found: UnpassedPackSettingRead[] = [];
  for (const node of nodes) {
    visitNodeTemplateSlots(node, slot => {
      if (slot.surface !== 'shell' && slot.surface !== 'script') return;
      if (readComposedMeta(slot.owner) !== undefined) return;
      const source = packSettingReadSource(slot, namedScripts);
      if (source === undefined) return;
      // Mirrors inputEnvVars: only a non-shell exec node's own `with:` reaches its env.
      const owner = slot.owner;
      const bound = new Set(
        isExecNode(owner) && owner.runtime !== 'sh' ? Object.keys(owner.with ?? {}) : []
      );
      for (const read of scanEnvironmentReads(source.text, source.runtime)) {
        const setting = settingByEnv.get(read.name);
        if (setting === undefined || passed(setting) || bound.has(setting)) continue;
        found.push({
          nodeId: owner.id,
          path: slot.path,
          location: `${source.label} line ${String(read.line)}`,
          envName: read.name,
          setting,
        });
      }
    });
  }
  return found;
}

function packSettingReadSource(
  slot: TemplateSlot,
  namedScripts: ReadonlyMap<string, ExecInputSource>
): ExecInputSource | undefined {
  if (slot.surface === 'shell') return { text: slot.value, label: 'bash', runtime: 'sh' };
  if (!isExecNode(slot.owner)) return undefined;
  if (isInlineScript(slot.value))
    return { text: slot.value, label: 'script', runtime: slot.owner.runtime };
  return namedScripts.get(slot.value);
}

function scanEnvironmentReads(
  source: string,
  runtime: ExecNode['runtime']
): readonly EnvironmentRead[] {
  const matches: { name: string; offset: number }[] = [];
  const collect = (pattern: RegExp, nameIndex: number): void => {
    for (const match of source.matchAll(pattern)) {
      const name = match[nameIndex];
      if (name !== undefined) matches.push({ name, offset: match.index });
    }
  };

  if (runtime === 'uv') {
    collect(/\bos\.environ\s*\[\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]/g, 2);
    collect(/\bos\.environ\.get\s*\(\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\1(?=\s*(?:,|\)))/g, 2);
  } else if (runtime === 'bun') {
    collect(/\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)\b/g, 1);
    collect(/\bprocess\.env\s*\[\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]/g, 2);
  } else {
    collect(new RegExp(`\\$\\{(${INPUT_ENV_PREFIX}[A-Z0-9_]+)\\}`, 'g'), 1);
    collect(new RegExp(`\\$(${INPUT_ENV_PREFIX}[A-Z0-9_]+)\\b`, 'g'), 1);
  }

  matches.sort((left, right) => left.offset - right.offset || left.name.localeCompare(right.name));
  const seen = new Set<string>();
  const reads: EnvironmentRead[] = [];
  for (const match of matches) {
    const line = countLinesThrough(source, match.offset);
    const key = `${match.name}\u0000${String(line)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reads.push({ ...match, line });
  }
  return reads;
}

function countLinesThrough(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) if (source.charCodeAt(index) === 10) line++;
  return line;
}
