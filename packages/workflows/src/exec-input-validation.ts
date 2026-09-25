import type { ExecNode, WorkflowDefinition } from './schemas';
import { inputEnvKey, isExecNode, isIncludeDirective } from './schemas';
import { EXEC_NODE_ENVIRONMENT_NAMES } from './exec-environment';
import { isInlineScript } from './executor-shared';
import type { TemplateSlot } from './template-walker';
import { visitNodeTemplateSlots } from './template-walker';

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

export function validateExecInputTargets(
  workflow: Pick<WorkflowDefinition, 'inputs'>,
  targets: readonly ExecInputValidationTarget[],
  resolveSource: (target: ExecInputValidationTarget) => ExecInputSource | undefined
): ExecInputValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const declaredInputs = Object.keys(workflow.inputs ?? {});

  for (const target of targets) {
    const source = resolveSource(target);
    if (source === undefined) continue;

    const availableNames = [...new Set([...target.bindingNames, ...declaredInputs])].sort();
    const availableEnv = new Set(EXEC_NODE_ENVIRONMENT_NAMES);
    for (const name of availableNames) availableEnv.add(inputEnvKey(name));

    for (const read of scanEnvironmentReads(source.text, source.runtime)) {
      if (availableEnv.has(read.name)) continue;
      if (read.name.startsWith('INPUTS_') && workflow.inputs === undefined) continue;
      const location = `${source.label} line ${String(read.line)}`;
      const available =
        availableNames.length === 0 ? 'none' : availableNames.map(name => `'${name}'`).join(', ');
      const prefix =
        `Node '${target.node.id}' ${target.slot.path} (${location}) reads environment variable ` +
        `'${read.name}', which is not provided by its bindings, declared inputs, or the engine. ` +
        `Available bindings/inputs: ${available}.`;

      if (read.name.startsWith('INPUTS_')) {
        const fix =
          target.node.runtime === 'sh'
            ? ` Declare a workflow input that maps to '${read.name}'; bash nodes do not support node-local 'with:' bindings.`
            : ` Add a matching 'with:' binding or declare a workflow input that maps to '${read.name}'.`;
        errors.push(prefix + fix);
      } else {
        warnings.push(prefix);
      }
    }
  }

  return { errors, warnings };
}

export function validateInlineExecInputs(workflow: WorkflowDefinition): ExecInputValidationResult {
  return validateExecInputTargets(
    workflow,
    collectExecInputValidationTargets(workflow),
    inlineExecInputSource
  );
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
    collect(/\$\{(INPUTS_[A-Z0-9_]+)\}/g, 1);
    collect(/\$(INPUTS_[A-Z0-9_]+)\b/g, 1);
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
