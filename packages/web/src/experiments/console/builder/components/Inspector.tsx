/**
 * Node inspector: edits the selected node's id, base fields, `when:`
 * condition, and variant-specific data. Every edit flows up through
 * `onPatch`/`onRename` into `BuilderPage`'s reducer — the inspector holds no
 * state of its own (id renames are committed on blur/Enter via a keyed
 * uncontrolled input so half-typed ids don't thrash the graph).
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { VARIANT_REGISTRY } from '../variants';
import { NODE_ID_PATTERN } from '../editor/state';
import type { BaseFields, BuilderNode } from '../types';
import { CheckboxField, Field, SelectField, TextField } from './inspector/fields';
import { PromptFields } from './inspector/PromptFields';
import { CommandFields } from './inspector/CommandFields';
import { BashFields } from './inspector/BashFields';
import { ScriptFields } from './inspector/ScriptFields';
import { LoopFields } from './inspector/LoopFields';
import { ApprovalFields } from './inspector/ApprovalFields';
import { CancelFields } from './inspector/CancelFields';
import { WhenBuilder } from './WhenBuilder';

interface InspectorProps {
  node: BuilderNode | null;
  /** How many nodes are selected (the inspector shows a hint for 0 / >1). */
  selectionCount: number;
  /** Ids the `when:` builder may reference (every other node). */
  otherIds: readonly string[];
  onPatch: (node: BuilderNode) => void;
  onRename: (id: string, nextId: string) => void;
}

const TRIGGER_RULES = [
  'all_success',
  'one_success',
  'none_failed_min_one_success',
  'all_done',
] as const;

function VariantFields({
  node,
  onPatch,
}: {
  node: BuilderNode;
  onPatch: (node: BuilderNode) => void;
}): ReactElement {
  switch (node.variant) {
    case 'prompt':
      return (
        <PromptFields
          data={node.data}
          onChange={(data): void => {
            onPatch({ ...node, data });
          }}
        />
      );
    case 'command':
      return (
        <CommandFields
          data={node.data}
          onChange={(data): void => {
            onPatch({ ...node, data });
          }}
        />
      );
    case 'bash':
      return (
        <BashFields
          data={node.data}
          onChange={(data): void => {
            onPatch({ ...node, data });
          }}
        />
      );
    case 'script':
      return (
        <ScriptFields
          data={node.data}
          onChange={(data): void => {
            onPatch({ ...node, data });
          }}
        />
      );
    case 'loop':
      return (
        <LoopFields
          data={node.data}
          onChange={(data): void => {
            onPatch({ ...node, data });
          }}
        />
      );
    case 'approval':
      return (
        <ApprovalFields
          data={node.data}
          onChange={(data): void => {
            onPatch({ ...node, data });
          }}
        />
      );
    case 'cancel':
      return (
        <CancelFields
          data={node.data}
          onChange={(data): void => {
            onPatch({ ...node, data });
          }}
        />
      );
  }
}

export function Inspector({
  node,
  selectionCount,
  otherIds,
  onPatch,
  onRename,
}: InspectorProps): ReactElement {
  const idRef = useRef<HTMLInputElement | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);

  // A stale error must not follow the selection to a different node.
  const nodeId = node?.id;
  useEffect(() => {
    setRenameError(null);
  }, [nodeId]);

  if (node === null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-[12.5px] text-text-tertiary">
        {selectionCount > 1
          ? `${String(selectionCount)} nodes selected — align, distribute, or copy them from the toolbar.`
          : 'Select a node to edit it.'}
      </div>
    );
  }

  const registry = VARIANT_REGISTRY[node.variant];
  const patchBase = (patch: Partial<BaseFields>): void => {
    onPatch({ ...node, base: { ...node.base, ...patch } });
  };

  const commitRename = (): void => {
    const next = idRef.current?.value.trim() ?? '';
    if (next.length === 0 || next === node.id) {
      setRenameError(null);
      return;
    }
    if (!NODE_ID_PATTERN.test(next)) {
      setRenameError('Ids use letters, digits, _ and - (no leading digit).');
      return;
    }
    setRenameError(null);
    onRename(node.id, next);
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-5 w-[3px] shrink-0 rounded-sm"
          style={{ background: `var(--node-${node.variant})` }}
        />
        <span className="text-[13px] font-semibold text-text-primary">{registry.label}</span>
        {registry.capabilities.requiresInteractive === true ? (
          <span className="rounded-full border border-border px-1.5 py-px font-mono text-[9px] uppercase tracking-widest text-text-tertiary">
            interactive
          </span>
        ) : null}
      </div>

      <Field label="Node id">
        <input
          key={node.id}
          ref={idRef}
          type="text"
          defaultValue={node.id}
          spellCheck={false}
          onBlur={commitRename}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>): void => {
            if (e.key === 'Enter') commitRename();
          }}
          className="w-full rounded-[8px] border border-border bg-surface px-2 py-1.5 font-mono text-[12.5px] text-text-primary outline-none focus:border-accent-bright/60"
        />
        {renameError !== null ? <p className="text-[11px] text-error">{renameError}</p> : null}
      </Field>

      <VariantFields node={node} onPatch={onPatch} />

      <hr className="border-border" />

      <Field label="Depends on (edit via canvas edges)">
        <div className="flex min-h-[26px] flex-wrap gap-1">
          {(node.base.depends_on ?? []).length === 0 ? (
            <span className="text-[11.5px] text-text-tertiary">no dependencies</span>
          ) : (
            (node.base.depends_on ?? []).map(dep => (
              <span
                key={dep}
                className="rounded bg-surface-inset px-1.5 py-0.5 font-mono text-[10.5px] text-text-secondary"
              >
                {dep}
              </span>
            ))
          )}
        </div>
      </Field>

      <WhenBuilder
        value={node.base.when}
        upstreamIds={otherIds}
        onChange={(when): void => {
          patchBase({ when });
        }}
      />

      <SelectField
        label="Trigger rule"
        value={node.base.trigger_rule ?? 'all_success'}
        options={TRIGGER_RULES.map(rule => ({ value: rule, label: rule }))}
        onChange={(raw): void => {
          const rule = TRIGGER_RULES.find(r => r === raw);
          patchBase({ trigger_rule: rule === 'all_success' ? undefined : rule });
        }}
      />

      {registry.capabilities.honorsAiFields ? (
        <>
          <TextField
            label="Provider"
            value={node.base.provider ?? ''}
            mono
            placeholder="inherit"
            onChange={(raw): void => {
              patchBase({ provider: raw.length > 0 ? raw : undefined });
            }}
          />
          <TextField
            label="Model"
            value={node.base.model ?? ''}
            mono
            placeholder="inherit (tier / @alias / literal)"
            onChange={(raw): void => {
              patchBase({ model: raw.length > 0 ? raw : undefined });
            }}
          />
          <CheckboxField
            label="Persist session across runs"
            checked={node.base.persist_session ?? false}
            onChange={(checked): void => {
              patchBase({ persist_session: checked ? true : undefined });
            }}
          />
        </>
      ) : null}

      <TextField
        label="Output type"
        value={node.base.output_type ?? ''}
        mono
        placeholder="e.g. plan, report"
        onChange={(raw): void => {
          patchBase({ output_type: raw.length > 0 ? raw : undefined });
        }}
      />
    </div>
  );
}
