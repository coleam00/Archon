import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { yaml as yamlLang } from '@codemirror/lang-yaml';
import { oneDark } from '@codemirror/theme-one-dark';
import { lintGutter, linter, type Diagnostic } from '@codemirror/lint';
import jsYaml from 'js-yaml';
import type { WorkflowDefinition, DagNode } from '@/lib/api';
import { cn } from '@/lib/utils';

interface YamlCodeViewProps {
  /** Controlled YAML text. */
  value: string;
  /** Optional change handler. When omitted, the editor renders read-only. */
  onChange?: (next: string) => void;
  mode: 'split' | 'full';
  readOnly?: boolean;
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
  if ('script' in node && node.script) {
    lines.push(`${pad}  script: ${serializeValue(node.script, baseIndent + 2)}`);
  }
  if ('runtime' in node && node.runtime) {
    lines.push(`${pad}  runtime: ${node.runtime}`);
  }
  if ('deps' in node && node.deps && node.deps.length > 0) {
    lines.push(`${pad}  deps:`);
    for (const dep of node.deps) {
      lines.push(`${pad}    - ${dep}`);
    }
  }
  if ('cancel' in node && node.cancel) {
    lines.push(`${pad}  cancel: ${serializeValue(node.cancel, baseIndent + 2)}`);
  }
  if ('approval' in node && node.approval) {
    lines.push(`${pad}  approval:`);
    lines.push(`${pad}    message: ${serializeValue(node.approval.message, baseIndent + 4)}`);
    if (node.approval.capture_response !== undefined) {
      lines.push(`${pad}    capture_response: ${node.approval.capture_response}`);
    }
    if (node.approval.on_reject) {
      lines.push(`${pad}    on_reject:`);
      lines.push(
        `${pad}      prompt: ${serializeValue(node.approval.on_reject.prompt, baseIndent + 6)}`
      );
      if (node.approval.on_reject.max_attempts !== undefined) {
        lines.push(`${pad}      max_attempts: ${node.approval.on_reject.max_attempts}`);
      }
    }
  }
  if ('loop' in node && node.loop) {
    lines.push(`${pad}  loop:`);
    lines.push(`${pad}    prompt: ${serializeValue(node.loop.prompt, baseIndent + 4)}`);
    lines.push(`${pad}    until: ${serializeValue(node.loop.until, baseIndent + 4)}`);
    lines.push(`${pad}    max_iterations: ${node.loop.max_iterations}`);
    if (node.loop.fresh_context !== undefined) {
      lines.push(`${pad}    fresh_context: ${node.loop.fresh_context}`);
    }
    if (node.loop.until_bash) {
      lines.push(`${pad}    until_bash: ${serializeValue(node.loop.until_bash, baseIndent + 4)}`);
    }
    if (node.loop.interactive !== undefined) {
      lines.push(`${pad}    interactive: ${node.loop.interactive}`);
    }
    if (node.loop.gate_message) {
      lines.push(
        `${pad}    gate_message: ${serializeValue(node.loop.gate_message, baseIndent + 4)}`
      );
    }
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

/** Parse YAML text. Throws if syntactically invalid; returns null for empty input. */
export function parseYamlToDefinition(text: string): WorkflowDefinition | null {
  if (!text.trim()) return null;
  const parsed = jsYaml.load(text);
  if (parsed === null || parsed === undefined) return null;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('YAML root must be an object');
  }
  return parsed as WorkflowDefinition;
}

/** Linter wrapper: surface js-yaml syntax errors as CodeMirror diagnostics. */
function makeYamlLinter(): ReturnType<typeof linter> {
  return linter(view => {
    const diagnostics: Diagnostic[] = [];
    const text = view.state.doc.toString();
    if (!text.trim()) return diagnostics;
    try {
      jsYaml.load(text);
    } catch (e) {
      const err = e as Error & { mark?: { position?: number } };
      const pos =
        typeof err.mark?.position === 'number'
          ? Math.min(err.mark.position, view.state.doc.length)
          : 0;
      diagnostics.push({
        from: pos,
        to: Math.min(pos + 1, view.state.doc.length),
        severity: 'error',
        message: err.message,
      });
    }
    return diagnostics;
  });
}

export function YamlCodeView({
  value,
  onChange,
  mode,
  readOnly,
}: YamlCodeViewProps): React.ReactElement {
  const isReadOnly = readOnly === true || onChange === undefined;
  const extensions = useMemo(() => [yamlLang(), lintGutter(), makeYamlLinter()], []);

  return (
    <div className="flex h-full flex-col bg-surface-inset">
      {mode === 'full' && (
        <div className="flex items-center border-b border-border px-3 py-2">
          <span className="text-xs text-text-tertiary">
            {isReadOnly ? 'Read-only YAML preview' : 'YAML editor — edits sync to the canvas'}
          </span>
        </div>
      )}
      <div className={cn('flex-1 overflow-auto')}>
        <CodeMirror
          value={value || '# No workflow definition'}
          height="100%"
          theme={oneDark}
          extensions={extensions}
          editable={!isReadOnly}
          readOnly={isReadOnly}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: !isReadOnly,
            highlightActiveLineGutter: !isReadOnly,
          }}
          onChange={isReadOnly ? undefined : onChange}
        />
      </div>
    </div>
  );
}
