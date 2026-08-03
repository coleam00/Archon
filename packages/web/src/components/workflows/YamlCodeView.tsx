import type { WorkflowDefinition, DagNode } from '@/lib/api';
import { cn } from '@/lib/utils';

interface YamlCodeViewProps {
  definition: WorkflowDefinition | null;
  mode: 'split' | 'full';
}

/** Serialize a single value — handles strings with newlines, objects, arrays. */
function serializeValue(value: unknown, currentIndent: number): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    // Multi-line strings use block scalar
    if (value.includes('\n')) {
      const lines = value.split('\n');
      return '|\n' + lines.map(l => ' '.repeat(currentIndent + 2) + l).join('\n');
    }
    // Quote strings that could be ambiguous
    if (
      value === '' ||
      value === 'true' ||
      value === 'false' ||
      value === 'null' ||
      /^[\d.]+$/.test(value) ||
      value.includes(':') ||
      value.includes('#') ||
      value.includes('"') ||
      value.includes("'")
    ) {
      return JSON.stringify(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return (
      '\n' +
      value
        .map(v => ' '.repeat(currentIndent + 2) + '- ' + serializeValue(v, currentIndent + 4))
        .join('\n')
    );
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    return (
      '\n' +
      entries
        .map(
          ([k, v]) =>
            ' '.repeat(currentIndent + 2) + k + ': ' + serializeValue(v, currentIndent + 2)
        )
        .join('\n')
    );
  }
  // Fallback for unexpected types — should not be reached after all type guards above
  return JSON.stringify(value);
}

/** Serialize a DagNode to YAML-like lines. */
function serializeDagNode(node: DagNode, baseIndent: number): string {
  const lines: string[] = [];
  const pad = ' '.repeat(baseIndent);

  lines.push(`${pad}- id: ${node.id}`);

  if ('command' in node && node.command) {
    lines.push(`${pad}  command: ${node.command}`);
  }
  if ('prompt' in node && node.prompt) {
    lines.push(`${pad}  prompt: ${serializeValue(node.prompt, baseIndent + 2)}`);
  }
  if ('bash' in node && node.bash) {
    lines.push(`${pad}  bash: ${serializeValue(node.bash, baseIndent + 2)}`);
  }
  if ('timeout' in node && node.timeout !== undefined) {
    lines.push(`${pad}  timeout: ${node.timeout}`);
  }
  if (node.depends_on && node.depends_on.length > 0) {
    lines.push(`${pad}  depends_on:`);
    for (const dep of node.depends_on) {
      lines.push(`${pad}    - ${dep}`);
    }
  }
  if (node.when) {
    lines.push(`${pad}  when: ${JSON.stringify(node.when)}`);
  }
  if (node.trigger_rule) {
    lines.push(`${pad}  trigger_rule: ${node.trigger_rule}`);
  }
  if (node.provider) {
    lines.push(`${pad}  provider: ${node.provider}`);
  }
  if (node.model) {
    lines.push(`${pad}  model: ${node.model}`);
  }
  if (node.context) {
    lines.push(`${pad}  context: ${node.context}`);
  }
  if (node.output_format) {
    lines.push(`${pad}  output_format: ${serializeValue(node.output_format, baseIndent + 2)}`);
  }
  if (node.allowed_tools) {
    lines.push(`${pad}  allowed_tools:`);
    for (const tool of node.allowed_tools) {
      lines.push(`${pad}    - ${tool}`);
    }
  }
  if (node.denied_tools) {
    lines.push(`${pad}  denied_tools:`);
    for (const tool of node.denied_tools) {
      lines.push(`${pad}    - ${tool}`);
    }
  }
  if (node.idle_timeout !== undefined) {
    lines.push(`${pad}  idle_timeout: ${node.idle_timeout}`);
  }
  if (node.skills && node.skills.length > 0) {
    lines.push(`${pad}  skills:`);
    for (const skill of node.skills) {
      lines.push(`${pad}    - ${skill}`);
    }
  }
  if (node.mcp) {
    lines.push(`${pad}  mcp: ${node.mcp}`);
  }
  if (node.retry) {
    lines.push(`${pad}  retry:`);
    lines.push(`${pad}    max_attempts: ${node.retry.max_attempts}`);
    if (node.retry.delay_ms !== undefined) {
      lines.push(`${pad}    delay_ms: ${node.retry.delay_ms}`);
    }
    if (node.retry.on_error) {
      lines.push(`${pad}    on_error: ${node.retry.on_error}`);
    }
  }

  return lines.join('\n');
}

/** Convert a WorkflowDefinition into a YAML-like string for preview. */
export function serializeToYaml(def: WorkflowDefinition): string {
  const lines: string[] = [];

  lines.push(`name: ${def.name}`);
  if (def.description) {
    lines.push(`description: ${serializeValue(def.description, 0)}`);
  }

  if (def.provider) {
    lines.push(`provider: ${def.provider}`);
  }
  if (def.model) {
    lines.push(`model: ${def.model}`);
  }
  if (def.modelReasoningEffort) {
    lines.push(`modelReasoningEffort: ${def.modelReasoningEffort}`);
  }
  if (def.webSearchMode) {
    lines.push(`webSearchMode: ${def.webSearchMode}`);
  }

  lines.push('');

  lines.push('nodes:');
  for (const node of def.nodes) {
    lines.push(serializeDagNode(node, 2));
  }

  return lines.join('\n') + '\n';
}

export function YamlCodeView({ definition, mode }: YamlCodeViewProps): React.ReactElement {
  const yamlText = definition ? serializeToYaml(definition) : '';

  return (
    <div className="flex h-full flex-col bg-surface-inset">
      {mode === 'full' && (
        <div className="flex items-center border-b border-border px-3 py-2">
          <span className="text-xs text-text-tertiary">Read-only YAML preview</span>
        </div>
      )}
      <pre
        className={cn(
          'flex-1 overflow-auto p-4',
          'font-mono text-xs leading-relaxed text-text-primary',
          'whitespace-pre-wrap break-words'
        )}
      >
        {yamlText || '# No workflow definition'}
      </pre>
    </div>
  );
}
