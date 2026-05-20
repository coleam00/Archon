import { CmEditor, Field } from '../../components/inspector/shared';
import { useWhenContext } from '../../components/when/useWhenContext';
import type { InspectorProps } from '../shared/types';
import { GeneralTab } from '../shared/GeneralTab';
import { inputStyle } from '../shared/inspectorStyles';
import type { LoopNodeData } from './data';

/**
 * Patches into the nested `loop` object emit `{ loop: { field: value } }` so
 * mergePatch deep-merges instead of replacing the whole loop config — preserves
 * sibling fields the inspector doesn't touch (until_bash, etc.).
 */
export function LoopInspector({
  id,
  data,
  base,
  onChange,
  siblingIds,
}: InspectorProps<LoopNodeData>): JSX.Element {
  const patchLoop = (patch: Record<string, unknown>): void => {
    onChange({ loop: patch });
  };
  const loop = data.loop;
  const { extensions } = useWhenContext(id);

  return (
    <GeneralTab base={base} siblingIds={siblingIds} onChange={onChange}>
      <div data-field="loop.prompt">
        <Field label="Prompt" hint="Body executed each iteration. Type $ for upstream references.">
          <CmEditor
            ariaLabel="Prompt"
            value={loop.prompt ?? ''}
            onChange={next => {
              patchLoop({ prompt: next });
            }}
            extensions={extensions}
            minHeight={120}
          />
        </Field>
      </div>
      <div data-field="loop.until">
        <Field
          label="Until (signal)"
          htmlFor={`loop-until-${id}`}
          hint="String emitted by the AI when complete (e.g. COMPLETE)."
        >
          <input
            id={`loop-until-${id}`}
            aria-label="Until"
            value={loop.until ?? ''}
            onChange={e => {
              patchLoop({ until: e.target.value });
            }}
            style={inputStyle}
          />
        </Field>
      </div>
      <div data-field="loop.max_iterations">
        <Field
          label="Max iterations"
          htmlFor={`loop-max-${id}`}
          hint="Hard cap; exceeding fails the node."
        >
          <input
            id={`loop-max-${id}`}
            aria-label="Max iterations"
            type="number"
            min={1}
            value={loop.max_iterations ?? 10}
            onChange={e => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0) patchLoop({ max_iterations: v });
            }}
            style={inputStyle}
          />
        </Field>
      </div>
      <Field
        label="Fresh context"
        htmlFor={`loop-fresh-${id}`}
        hint="When true, each iteration starts a fresh AI session."
      >
        <input
          id={`loop-fresh-${id}`}
          aria-label="Fresh context"
          type="checkbox"
          checked={loop.fresh_context ?? false}
          onChange={e => {
            patchLoop({ fresh_context: e.target.checked });
          }}
        />
      </Field>
      <Field
        label="Interactive"
        htmlFor={`loop-int-${id}`}
        hint="When true, pause between iterations for /workflow approve."
      >
        <input
          id={`loop-int-${id}`}
          aria-label="Interactive"
          type="checkbox"
          checked={loop.interactive ?? false}
          onChange={e => {
            patchLoop({ interactive: e.target.checked || null });
          }}
        />
      </Field>
      {loop.interactive ? (
        <Field
          label="Gate message"
          hint="Required when interactive — shown to user when paused. Type $ for upstream references."
        >
          <CmEditor
            ariaLabel="Gate message"
            value={loop.gate_message ?? ''}
            onChange={next => {
              patchLoop({ gate_message: next === '' ? null : next });
            }}
            extensions={extensions}
            minHeight={60}
          />
        </Field>
      ) : null}
      <Field label="Until (bash)" hint="Optional bash check; exit 0 = complete.">
        <CmEditor
          ariaLabel="Until bash"
          value={loop.until_bash ?? ''}
          onChange={next => {
            patchLoop({ until_bash: next === '' ? null : next });
          }}
          extensions={extensions}
          minHeight={60}
        />
      </Field>
    </GeneralTab>
  );
}
