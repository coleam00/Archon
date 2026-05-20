import type { InspectorProps } from '../../../nodes/shared/types';
import { JsonField } from '../shared';

/**
 * Shared base-field tab for per-node `hooks`. Drift §8 (user decision):
 * ship a JsonField, NOT the row-editor in the plan snippet.
 *
 * Why: actual schema is `Record<EventName, Array<{matcher?, response, timeout?}>>`
 * with 21 named events and structured JSON `response` (the SDK's
 * SyncHookJSONOutput, not a shell command). The plan's
 * `{event, match, command, blocking}[]` flat-row UI does not model this.
 * A real structured editor is Phase 8 polish; for Phase 4 ship the raw
 * JSON editor with the same forward-compat semantics as AdvancedTab.
 */
export function HooksTab({ base, onChange }: InspectorProps<unknown>): JSX.Element {
  return (
    <JsonField
      label="Hooks"
      value={base.hooks ?? {}}
      onChange={v => {
        onChange({ hooks: v && Object.keys(v as object).length ? v : null });
      }}
      hint="Keyed by event (e.g. PreToolUse). Each event holds an array of {matcher?, response, timeout?}. See workflow hooks docs."
    />
  );
}
