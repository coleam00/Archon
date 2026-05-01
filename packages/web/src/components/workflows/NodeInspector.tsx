import { useState, useCallback } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { DagNodeData } from './DagNodeComponent';
import type { CommandEntry, DagNode } from '@/lib/api';
import { useProviders } from '@/hooks/useProviders';

// Keep in sync with triggerRuleSchema.options in @archon/workflows/schemas/dag-node.ts
// (api.generated.d.ts is type-only and cannot export runtime values)
type TriggerRule = NonNullable<DagNode['trigger_rule']>;
const TRIGGER_RULES: readonly TriggerRule[] = [
  'all_success',
  'one_success',
  'none_failed_min_one_success',
  'all_done',
];

/** New DAG-mode inspector props (tabbed right panel). */
export interface NodeInspectorProps {
  node: DagNodeData;
  commands: CommandEntry[];
  onUpdate: (updates: Partial<DagNodeData>) => void;
  onDelete: () => void;
  onClose: () => void;
}

const inputClass =
  'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent';

const selectClass =
  'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent';

const labelClass = 'text-[10px] text-text-tertiary uppercase tracking-wide';

const textareaClass =
  'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent resize-y';

function parseToolsList(value: string): string[] | undefined {
  if (!value.trim()) return undefined;
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <label className={labelClass}>{label}</label>
      {children}
    </div>
  );
}

function ProviderField({
  node,
  onUpdate,
  selectClass: cls,
}: {
  node: DagNodeData;
  onUpdate: (updates: Partial<DagNodeData>) => void;
  selectClass: string;
}): React.ReactElement {
  const { providers } = useProviders();
  return (
    <Field label="Provider">
      <select
        value={node.provider ?? ''}
        onChange={(e): void => {
          onUpdate({ provider: e.target.value || undefined });
        }}
        className={cls}
      >
        <option value="">Inherit</option>
        {providers.map(p => (
          <option key={p.id} value={p.id}>
            {p.displayName}
          </option>
        ))}
      </select>
    </Field>
  );
}

type ToolsMode = 'none' | 'allow' | 'deny';

const TOOLS_MODE_LABELS: Record<ToolsMode, string> = {
  none: 'Default',
  allow: 'Allow',
  deny: 'Deny',
};

function resolveToolsMode(node: DagNodeData): ToolsMode {
  if (node.allowed_tools !== undefined) return 'allow';
  if (node.denied_tools !== undefined) return 'deny';
  return 'none';
}

function DependencyTags({
  values,
  onChange,
}: {
  values: string[];
  onChange: (deps: string[] | undefined) => void;
}): React.ReactElement {
  const [adding, setAdding] = useState(false);
  const [addValue, setAddValue] = useState('');

  const handleAdd = (): void => {
    const trimmed = addValue.trim();
    if (trimmed && !values.includes(trimmed)) {
      onChange([...values, trimmed]);
    }
    setAddValue('');
    setAdding(false);
  };

  const handleRemove = (dep: string): void => {
    const next = values.filter(v => v !== dep);
    onChange(next.length > 0 ? next : undefined);
  };

  return (
    <div className="flex flex-wrap gap-1 items-center">
      {values.map(dep => (
        <span
          key={dep}
          className="inline-flex items-center gap-1 rounded-md bg-surface-elevated px-1.5 py-0.5 text-[10px] font-mono text-text-secondary"
        >
          {dep}
          <button
            type="button"
            onClick={(): void => {
              handleRemove(dep);
            }}
            className="text-text-tertiary hover:text-error"
          >
            x
          </button>
        </span>
      ))}
      {adding ? (
        <input
          type="text"
          value={addValue}
          onChange={(e): void => {
            setAddValue(e.target.value);
          }}
          onKeyDown={(e): void => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAdd();
            }
            if (e.key === 'Escape') {
              setAdding(false);
              setAddValue('');
            }
          }}
          onBlur={handleAdd}
          autoFocus
          placeholder="node-id"
          className="w-20 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10px] font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
        />
      ) : (
        <button
          type="button"
          onClick={(): void => {
            setAdding(true);
          }}
          className="inline-flex items-center rounded-md border border-dashed border-border px-1.5 py-0.5 text-[10px] text-text-tertiary hover:text-text-secondary hover:border-accent"
        >
          +
        </button>
      )}
    </div>
  );
}

function GeneralTab({
  node,
  commands,
  onUpdate,
}: {
  node: DagNodeData;
  commands: CommandEntry[];
  onUpdate: (updates: Partial<DagNodeData>) => void;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Node ID */}
      <Field label="Node ID">
        <input
          type="text"
          value={node.id}
          onChange={(e): void => {
            onUpdate({ id: e.target.value });
          }}
          className={cn(inputClass, 'font-mono')}
        />
        <p className="text-[9px] text-warning">
          Changing the node ID may break dependency references.
        </p>
      </Field>

      {/* Type selector */}
      <Field label="Type">
        <select
          value={node.nodeType}
          onChange={(e): void => {
            const newType = e.target.value as DagNodeData['nodeType'];
            // Clear ALL variant-specific fields, then set defaults for the new type.
            const updates: Partial<DagNodeData> = {
              nodeType: newType,
              promptText: undefined,
              bashScript: undefined,
              bashTimeout: undefined,
              scriptBody: undefined,
              scriptRuntime: undefined,
              scriptDeps: undefined,
              scriptTimeout: undefined,
              loopConfig: undefined,
              approvalConfig: undefined,
              cancelReason: undefined,
            };
            if (newType === 'command') {
              updates.label = '';
            } else if (newType === 'prompt') {
              updates.label = 'Prompt';
            } else if (newType === 'bash') {
              updates.label = 'Shell';
              // Bash has no AI fields — clear them.
              updates.allowed_tools = undefined;
              updates.denied_tools = undefined;
              updates.output_format = undefined;
              updates.hooks = undefined;
              updates.mcp = undefined;
              updates.skills = undefined;
            } else if (newType === 'script') {
              updates.label = 'Script';
              updates.scriptRuntime = 'bun';
              updates.allowed_tools = undefined;
              updates.denied_tools = undefined;
              updates.output_format = undefined;
              updates.hooks = undefined;
              updates.mcp = undefined;
              updates.skills = undefined;
            } else if (newType === 'loop') {
              updates.label = 'Loop';
              updates.loopConfig = {
                prompt: '',
                until: 'COMPLETE',
                max_iterations: 5,
                fresh_context: false,
              };
            } else if (newType === 'approval') {
              updates.label = 'Approval';
              updates.approvalConfig = { message: 'Review and approve to continue' };
              updates.allowed_tools = undefined;
              updates.denied_tools = undefined;
              updates.output_format = undefined;
              updates.hooks = undefined;
              updates.mcp = undefined;
              updates.skills = undefined;
            } else if (newType === 'cancel') {
              updates.label = 'Cancel';
              updates.cancelReason = '';
              updates.allowed_tools = undefined;
              updates.denied_tools = undefined;
              updates.output_format = undefined;
              updates.hooks = undefined;
              updates.mcp = undefined;
              updates.skills = undefined;
            }
            onUpdate(updates);
          }}
          className={selectClass}
        >
          <option value="command">Command</option>
          <option value="prompt">Prompt</option>
          <option value="bash">Bash</option>
          <option value="script">Script</option>
          <option value="loop">Loop</option>
          <option value="approval">Approval</option>
          <option value="cancel">Cancel</option>
        </select>
      </Field>

      {/* Type-adaptive content */}
      {node.nodeType === 'command' && (
        <Field label="Command">
          <select
            value={node.label}
            onChange={(e): void => {
              onUpdate({ label: e.target.value });
            }}
            className={selectClass}
          >
            <option value="">Select command...</option>
            {commands.map(cmd => (
              <option key={cmd.name} value={cmd.name}>
                {cmd.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      {node.nodeType === 'prompt' && (
        <Field label="Prompt">
          <textarea
            value={node.promptText ?? ''}
            onChange={(e): void => {
              onUpdate({ promptText: e.target.value });
            }}
            rows={5}
            placeholder="Enter inline prompt..."
            className={cn(textareaClass, 'min-h-[120px]')}
          />
        </Field>
      )}

      {node.nodeType === 'bash' && (
        <>
          <Field label="Shell Script">
            <textarea
              value={node.bashScript ?? ''}
              onChange={(e): void => {
                onUpdate({ bashScript: e.target.value });
              }}
              rows={5}
              placeholder="echo 'hello world'"
              className={cn(textareaClass, 'min-h-[120px]')}
            />
          </Field>
          <Field label="Timeout (ms)">
            <input
              type="number"
              value={node.bashTimeout ?? ''}
              onChange={(e): void => {
                const v = e.target.value;
                onUpdate({ bashTimeout: v ? Number(v) : undefined });
              }}
              placeholder="120000"
              className={inputClass}
            />
          </Field>
        </>
      )}

      {node.nodeType === 'script' && (
        <>
          <Field label="Runtime">
            <select
              value={node.scriptRuntime ?? ''}
              onChange={(e): void => {
                onUpdate({
                  scriptRuntime: (e.target.value || undefined) as 'bun' | 'uv' | undefined,
                });
              }}
              className={selectClass}
            >
              <option value="">Select runtime...</option>
              <option value="bun">bun (TypeScript / JavaScript)</option>
              <option value="uv">uv (Python)</option>
            </select>
          </Field>
          <Field label="Script">
            <textarea
              value={node.scriptBody ?? ''}
              onChange={(e): void => {
                onUpdate({ scriptBody: e.target.value });
              }}
              rows={6}
              placeholder={
                node.scriptRuntime === 'uv' ? "print('hello world')" : "console.log('hello world')"
              }
              className={cn(textareaClass, 'min-h-[140px]')}
            />
          </Field>
          <Field label="Dependencies (comma-separated)">
            <input
              type="text"
              value={node.scriptDeps?.join(', ') ?? ''}
              onChange={(e): void => {
                onUpdate({ scriptDeps: parseToolsList(e.target.value) });
              }}
              placeholder={node.scriptRuntime === 'uv' ? 'requests, pydantic' : 'zod, lodash'}
              className={inputClass}
            />
          </Field>
          <Field label="Timeout (ms)">
            <input
              type="number"
              value={node.scriptTimeout ?? ''}
              onChange={(e): void => {
                const v = e.target.value;
                onUpdate({ scriptTimeout: v ? Number(v) : undefined });
              }}
              placeholder="120000"
              className={inputClass}
            />
          </Field>
        </>
      )}

      {node.nodeType === 'loop' && (
        <>
          <Field label="Iteration Prompt">
            <textarea
              value={node.loopConfig?.prompt ?? ''}
              onChange={(e): void => {
                onUpdate({
                  loopConfig: {
                    ...(node.loopConfig ?? {
                      prompt: '',
                      until: '',
                      max_iterations: 1,
                      fresh_context: false,
                    }),
                    prompt: e.target.value,
                  },
                });
              }}
              rows={5}
              placeholder="Continue working until you can output the completion signal..."
              className={cn(textareaClass, 'min-h-[120px]')}
            />
          </Field>
          <Field label="Completion Signal (until)">
            <input
              type="text"
              value={node.loopConfig?.until ?? ''}
              onChange={(e): void => {
                onUpdate({
                  loopConfig: {
                    ...(node.loopConfig ?? {
                      prompt: '',
                      until: '',
                      max_iterations: 1,
                      fresh_context: false,
                    }),
                    until: e.target.value,
                  },
                });
              }}
              placeholder="COMPLETE"
              className={cn(inputClass, 'font-mono')}
            />
          </Field>
          <Field label="Max Iterations">
            <input
              type="number"
              min={1}
              value={node.loopConfig?.max_iterations ?? ''}
              onChange={(e): void => {
                const v = e.target.value;
                onUpdate({
                  loopConfig: {
                    ...(node.loopConfig ?? {
                      prompt: '',
                      until: '',
                      max_iterations: 1,
                      fresh_context: false,
                    }),
                    max_iterations: v ? Number(v) : 1,
                  },
                });
              }}
              placeholder="5"
              className={inputClass}
            />
          </Field>
          <Field label="Fresh Context Each Iteration">
            <label className="flex items-center gap-2 text-xs text-text-secondary">
              <input
                type="checkbox"
                checked={node.loopConfig?.fresh_context ?? false}
                onChange={(e): void => {
                  onUpdate({
                    loopConfig: {
                      ...(node.loopConfig ?? {
                        prompt: '',
                        until: '',
                        max_iterations: 1,
                        fresh_context: false,
                      }),
                      fresh_context: e.target.checked,
                    },
                  });
                }}
              />
              Restart session per iteration
            </label>
          </Field>
          <Field label="Until Bash (optional)">
            <textarea
              value={node.loopConfig?.until_bash ?? ''}
              onChange={(e): void => {
                onUpdate({
                  loopConfig: {
                    ...(node.loopConfig ?? {
                      prompt: '',
                      until: '',
                      max_iterations: 1,
                      fresh_context: false,
                    }),
                    until_bash: e.target.value || undefined,
                  },
                });
              }}
              rows={3}
              placeholder="bun run validate"
              className={cn(textareaClass, 'min-h-[60px]')}
            />
            <p className="text-[9px] text-text-tertiary">Exit 0 marks the loop complete.</p>
          </Field>
          <Field label="Interactive">
            <label className="flex items-center gap-2 text-xs text-text-secondary">
              <input
                type="checkbox"
                checked={node.loopConfig?.interactive ?? false}
                onChange={(e): void => {
                  onUpdate({
                    loopConfig: {
                      ...(node.loopConfig ?? {
                        prompt: '',
                        until: '',
                        max_iterations: 1,
                        fresh_context: false,
                      }),
                      interactive: e.target.checked || undefined,
                    },
                  });
                }}
              />
              Pause for user feedback between iterations
            </label>
          </Field>
          {node.loopConfig?.interactive && (
            <Field label="Gate Message">
              <textarea
                value={node.loopConfig?.gate_message ?? ''}
                onChange={(e): void => {
                  onUpdate({
                    loopConfig: {
                      ...(node.loopConfig ?? {
                        prompt: '',
                        until: '',
                        max_iterations: 1,
                        fresh_context: false,
                      }),
                      gate_message: e.target.value || undefined,
                    },
                  });
                }}
                rows={2}
                placeholder="Review iteration output and approve to continue"
                className={cn(textareaClass, 'min-h-[60px]')}
              />
            </Field>
          )}
        </>
      )}

      {node.nodeType === 'approval' && (
        <>
          <Field label="Message">
            <textarea
              value={node.approvalConfig?.message ?? ''}
              onChange={(e): void => {
                onUpdate({
                  approvalConfig: {
                    ...(node.approvalConfig ?? { message: '' }),
                    message: e.target.value,
                  },
                });
              }}
              rows={3}
              placeholder="Review the changes and approve to continue"
              className={cn(textareaClass, 'min-h-[80px]')}
            />
          </Field>
          <Field label="Capture Response">
            <label className="flex items-center gap-2 text-xs text-text-secondary">
              <input
                type="checkbox"
                checked={node.approvalConfig?.capture_response ?? false}
                onChange={(e): void => {
                  onUpdate({
                    approvalConfig: {
                      ...(node.approvalConfig ?? { message: '' }),
                      capture_response: e.target.checked || undefined,
                    },
                  });
                }}
              />
              Store the reviewer&apos;s comment as <code className="text-[10px]">$id.output</code>
            </label>
          </Field>
          <div className="border-t border-border pt-3 mt-1">
            <p className={cn(labelClass, 'mb-2')}>On Reject</p>
            <Field label="Rework Prompt (optional)">
              <textarea
                value={node.approvalConfig?.on_reject?.prompt ?? ''}
                onChange={(e): void => {
                  const text = e.target.value;
                  const existing = node.approvalConfig ?? { message: '' };
                  if (!text) {
                    // Clear on_reject when prompt empties.
                    const { on_reject: dropped, ...rest } = existing;
                    void dropped;
                    onUpdate({ approvalConfig: rest });
                    return;
                  }
                  onUpdate({
                    approvalConfig: {
                      ...existing,
                      on_reject: {
                        ...(existing.on_reject ?? { prompt: '' }),
                        prompt: text,
                      },
                    },
                  });
                }}
                rows={3}
                placeholder="Address the review feedback: $REJECTION_REASON"
                className={cn(textareaClass, 'min-h-[80px]')}
              />
            </Field>
            {node.approvalConfig?.on_reject && (
              <Field label="Max Attempts (1-10)">
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={node.approvalConfig?.on_reject?.max_attempts ?? ''}
                  onChange={(e): void => {
                    const v = e.target.value;
                    const existing = node.approvalConfig ?? { message: '' };
                    if (!existing.on_reject) return;
                    onUpdate({
                      approvalConfig: {
                        ...existing,
                        on_reject: {
                          ...existing.on_reject,
                          max_attempts: v ? Number(v) : undefined,
                        },
                      },
                    });
                  }}
                  placeholder="3"
                  className={inputClass}
                />
              </Field>
            )}
          </div>
        </>
      )}

      {node.nodeType === 'cancel' && (
        <Field label="Cancel Reason">
          <textarea
            value={node.cancelReason ?? ''}
            onChange={(e): void => {
              onUpdate({ cancelReason: e.target.value });
            }}
            rows={3}
            placeholder="Required preconditions not met"
            className={cn(textareaClass, 'min-h-[80px]')}
          />
          <p className="text-[9px] text-text-tertiary">
            Reaching this node terminates the run with the given reason.
          </p>
        </Field>
      )}

      {/* Dependencies */}
      <Field label="Dependencies">
        <DependencyTags
          values={node.depends_on ?? []}
          onChange={(deps): void => {
            onUpdate({ depends_on: deps });
          }}
        />
      </Field>

      {/* When condition */}
      <Field label="When Condition">
        <input
          type="text"
          value={node.when ?? ''}
          onChange={(e): void => {
            onUpdate({ when: e.target.value || undefined });
          }}
          placeholder="$nodeId.output.field == 'value'"
          className={cn(inputClass, 'font-mono')}
        />
      </Field>
    </div>
  );
}

/** Nodes that don't run the AI provider — bash, script, approval, cancel. (loop is AI; it just constrains AI fields.) */
function isNoAiNode(nodeType: DagNodeData['nodeType']): boolean {
  return (
    nodeType === 'bash' || nodeType === 'script' || nodeType === 'approval' || nodeType === 'cancel'
  );
}

function ExecutionTab({
  node,
  onUpdate,
}: {
  node: DagNodeData;
  onUpdate: (updates: Partial<DagNodeData>) => void;
}): React.ReactElement {
  const showAiFields = !isNoAiNode(node.nodeType);

  return (
    <div className="flex flex-col gap-3 p-3">
      {showAiFields && (
        <>
          <ProviderField node={node} onUpdate={onUpdate} selectClass={selectClass} />

          <Field label="Model">
            <input
              type="text"
              value={node.model ?? ''}
              onChange={(e): void => {
                onUpdate({ model: e.target.value || undefined });
              }}
              placeholder="Inherit"
              className={inputClass}
            />
          </Field>

          <Field label="Context">
            <select
              value={node.context ?? ''}
              onChange={(e): void => {
                onUpdate({ context: (e.target.value || undefined) as 'fresh' | undefined });
              }}
              className={selectClass}
            >
              <option value="">Inherit</option>
              <option value="fresh">Fresh</option>
            </select>
          </Field>
        </>
      )}

      <Field label="Trigger Rule">
        <select
          value={node.trigger_rule ?? ''}
          onChange={(e): void => {
            onUpdate({
              trigger_rule: (e.target.value || undefined) as TriggerRule | undefined,
            });
          }}
          className={selectClass}
        >
          <option value="">Default (all_success)</option>
          {TRIGGER_RULES.map(rule => (
            <option key={rule} value={rule}>
              {rule}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Idle Timeout (ms)">
        <input
          type="number"
          value={node.idle_timeout ?? ''}
          onChange={(e): void => {
            const v = e.target.value;
            onUpdate({ idle_timeout: v ? Number(v) : undefined });
          }}
          placeholder="300000"
          className={inputClass}
        />
      </Field>

      {/* Retry config — engine forbids retry on loop nodes (loop manages its own iteration). */}
      {node.nodeType !== 'loop' && (
        <div className="border-t border-border pt-3 mt-1">
          <p className={cn(labelClass, 'mb-2')}>Retry Configuration</p>

          <div className="flex flex-col gap-2">
            <Field label="Max Attempts (1-5)">
              <input
                type="number"
                min={1}
                max={5}
                value={node.retry?.max_attempts ?? ''}
                onChange={(e): void => {
                  const v = e.target.value;
                  if (!v) {
                    onUpdate({ retry: undefined });
                  } else {
                    onUpdate({
                      retry: {
                        max_attempts: Number(v),
                        delay_ms: node.retry?.delay_ms,
                        on_error: node.retry?.on_error,
                      },
                    });
                  }
                }}
                placeholder="2"
                className={inputClass}
              />
            </Field>

            <Field label="Delay (ms, 1000-60000)">
              <input
                type="number"
                min={1000}
                max={60000}
                value={node.retry?.delay_ms ?? ''}
                onChange={(e): void => {
                  const v = e.target.value;
                  if (node.retry) {
                    onUpdate({
                      retry: {
                        ...node.retry,
                        delay_ms: v ? Number(v) : undefined,
                      },
                    });
                  }
                }}
                placeholder="3000"
                disabled={!node.retry}
                className={cn(inputClass, !node.retry && 'opacity-50')}
              />
            </Field>

            <Field label="On Error">
              <select
                value={node.retry?.on_error ?? ''}
                onChange={(e): void => {
                  if (node.retry) {
                    onUpdate({
                      retry: {
                        ...node.retry,
                        on_error: (e.target.value || undefined) as 'transient' | 'all' | undefined,
                      },
                    });
                  }
                }}
                disabled={!node.retry}
                className={cn(selectClass, !node.retry && 'opacity-50')}
              >
                <option value="">Default (transient)</option>
                <option value="transient">transient</option>
                <option value="all">all</option>
              </select>
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}

const TOOL_PRESETS: readonly {
  label: string;
  allowed: string[];
}[] = [
  { label: 'No tools', allowed: [] },
  { label: 'Read-only', allowed: ['Read', 'Glob', 'Grep'] },
  { label: 'Edit-only', allowed: ['Read', 'Write', 'Edit', 'Glob', 'Grep'] },
];

function ToolsTab({
  node,
  onUpdate,
}: {
  node: DagNodeData;
  onUpdate: (updates: Partial<DagNodeData>) => void;
}): React.ReactElement {
  const currentMode = resolveToolsMode(node);

  const handleModeChange = (mode: ToolsMode): void => {
    if (mode === 'none') {
      onUpdate({ allowed_tools: undefined, denied_tools: undefined });
    } else if (mode === 'allow') {
      onUpdate({ allowed_tools: node.allowed_tools ?? [], denied_tools: undefined });
    } else {
      onUpdate({ allowed_tools: undefined, denied_tools: node.denied_tools ?? [] });
    }
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <Field label="Mode">
        <div className="flex gap-1">
          {(['none', 'allow', 'deny'] as const).map(mode => (
            <button
              key={mode}
              type="button"
              onClick={(): void => {
                handleModeChange(mode);
              }}
              className={cn(
                'flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                currentMode === mode
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-surface-elevated text-text-secondary hover:text-text-primary'
              )}
            >
              {TOOLS_MODE_LABELS[mode]}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Presets">
        <div className="flex flex-wrap gap-1">
          {TOOL_PRESETS.map(preset => (
            <button
              key={preset.label}
              type="button"
              onClick={(): void => {
                onUpdate({ allowed_tools: preset.allowed, denied_tools: undefined });
              }}
              className="rounded-full border border-border px-2 py-0.5 text-[10px] text-text-secondary hover:text-text-primary hover:border-accent transition-colors"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Allowed Tools">
        <input
          type="text"
          value={node.allowed_tools?.join(', ') ?? ''}
          onChange={(e): void => {
            onUpdate({ allowed_tools: parseToolsList(e.target.value) });
          }}
          placeholder="tool1, tool2..."
          className={inputClass}
        />
      </Field>

      <Field label="Denied Tools">
        <input
          type="text"
          value={node.denied_tools?.join(', ') ?? ''}
          onChange={(e): void => {
            onUpdate({ denied_tools: parseToolsList(e.target.value) });
          }}
          placeholder="tool1, tool2..."
          className={inputClass}
        />
      </Field>
    </div>
  );
}

function JsonTextareaField({
  label,
  value,
  placeholder,
  rows,
  onCommit,
}: {
  label: string;
  value: Record<string, unknown> | undefined;
  placeholder: string;
  rows: number;
  onCommit: (parsed: Record<string, unknown> | undefined) => void;
}): React.ReactElement {
  const [text, setText] = useState(value ? JSON.stringify(value, null, 2) : '');
  const [error, setError] = useState<string | null>(null);

  const handleChange = useCallback(
    (raw: string): void => {
      setText(raw);
      if (!raw.trim()) {
        setError(null);
        onCommit(undefined);
        return;
      }
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        setError(null);
        onCommit(parsed);
      } catch (e) {
        if (e instanceof SyntaxError) {
          setError(e.message);
        } else {
          throw e;
        }
      }
    },
    [onCommit]
  );

  return (
    <Field label={label}>
      <textarea
        value={text}
        onChange={(e): void => {
          handleChange(e.target.value);
        }}
        rows={rows}
        placeholder={placeholder}
        className={cn(textareaClass, 'min-h-[100px]')}
      />
      {error && <p className="text-[10px] text-error">{error}</p>}
    </Field>
  );
}

function AdvancedTab({
  node,
  onUpdate,
}: {
  node: DagNodeData;
  onUpdate: (updates: Partial<DagNodeData>) => void;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-3 p-3">
      <JsonTextareaField
        label="Output Format (JSON Schema)"
        value={node.output_format}
        placeholder='{"type": "object", "properties": {...}}'
        rows={5}
        onCommit={(v): void => {
          onUpdate({ output_format: v });
        }}
      />

      <Field label="Skills">
        <input
          type="text"
          value={node.skills?.join(', ') ?? ''}
          onChange={(e): void => {
            onUpdate({ skills: parseToolsList(e.target.value) });
          }}
          placeholder="skill1, skill2..."
          className={inputClass}
        />
      </Field>

      <Field label="MCP Config Path">
        <input
          type="text"
          value={node.mcp ?? ''}
          onChange={(e): void => {
            onUpdate({ mcp: e.target.value || undefined });
          }}
          placeholder=".archon/mcp/github.json"
          className={cn(inputClass, 'font-mono')}
        />
        <p className="text-[9px] text-text-tertiary">
          Path relative to repo root. JSON matching SDK McpServerConfig format.
        </p>
      </Field>

      <JsonTextareaField
        label="Hooks (SDK SyncHookJSONOutput)"
        value={node.hooks as Record<string, unknown> | undefined}
        placeholder='{"PreToolUse": [{"matcher": "Bash", "response": {...}}]}'
        rows={5}
        onCommit={(v): void => {
          onUpdate({ hooks: v });
        }}
      />
    </div>
  );
}

function DagInspector({
  node,
  commands,
  onUpdate,
  onDelete,
  onClose,
}: NodeInspectorProps): React.ReactElement {
  const showAiSurface = !isNoAiNode(node.nodeType);

  return (
    <div key={node.id} className="flex flex-col h-full border-l border-border bg-surface">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="flex-1 truncate text-xs font-semibold text-text-primary">
          {node.label || node.id}
        </span>
        <Button
          variant="destructive"
          size="sm"
          onClick={onDelete}
          className="h-6 shrink-0 px-2 text-[10px]"
          aria-label="Delete node"
        >
          Delete
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 px-1 text-sm leading-none text-text-tertiary hover:text-text-primary"
          title="Close inspector"
        >
          x
        </button>
      </div>

      {/* Tabbed content */}
      <Tabs defaultValue="general" className="flex-1 flex flex-col gap-0">
        <TabsList variant="line" className="px-2 pt-1 w-full justify-start">
          <TabsTrigger value="general" className="text-xs">
            General
          </TabsTrigger>
          <TabsTrigger value="execution" className="text-xs">
            Execution
          </TabsTrigger>
          {showAiSurface && (
            <TabsTrigger value="tools" className="text-xs">
              Tools
            </TabsTrigger>
          )}
          {showAiSurface && (
            <TabsTrigger value="advanced" className="text-xs">
              Advanced
            </TabsTrigger>
          )}
        </TabsList>

        <ScrollArea className="flex-1">
          <TabsContent value="general">
            <GeneralTab node={node} commands={commands} onUpdate={onUpdate} />
          </TabsContent>

          <TabsContent value="execution">
            <ExecutionTab node={node} onUpdate={onUpdate} />
          </TabsContent>

          {showAiSurface && (
            <TabsContent value="tools">
              <ToolsTab node={node} onUpdate={onUpdate} />
            </TabsContent>
          )}

          {showAiSurface && (
            <TabsContent value="advanced">
              <AdvancedTab key={node.id} node={node} onUpdate={onUpdate} />
            </TabsContent>
          )}
        </ScrollArea>
      </Tabs>
    </div>
  );
}

export function NodeInspector(props: NodeInspectorProps): React.ReactElement {
  return (
    <DagInspector
      node={props.node}
      commands={props.commands}
      onUpdate={props.onUpdate}
      onDelete={props.onDelete}
      onClose={props.onClose}
    />
  );
}
