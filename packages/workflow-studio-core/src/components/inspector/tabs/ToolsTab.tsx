import type { InspectorProps } from '../../../nodes/shared/types';
import { Field, JsonField } from '../shared';
import { textareaStyle } from '../../../nodes/shared/inspectorStyles';

const linesToList = (s: string): string[] =>
  s
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

/**
 * Shared base-field tab. Edits the tool-policy base fields:
 *   - allowed_tools (string list — line-per-row)
 *   - denied_tools (string list — line-per-row; drift §3 corrects plan's
 *     `disallowed_tools` to schema's `denied_tools`)
 *   - output_format (free-form JSON — schema is `z.record(z.unknown())`)
 */
export function ToolsTab({ base, onChange }: InspectorProps<unknown>): JSX.Element {
  return (
    <>
      <Field
        label="Allowed tools"
        htmlFor="tools-allowed"
        hint="One per line. Empty = no allow-list."
      >
        <textarea
          id="tools-allowed"
          aria-label="Allowed tools"
          value={((base.allowed_tools as string[]) ?? []).join('\n')}
          onChange={e => {
            const list = linesToList(e.target.value);
            onChange({ allowed_tools: list.length ? list : null });
          }}
          rows={4}
          style={textareaStyle}
        />
      </Field>
      <Field
        label="Denied tools"
        htmlFor="tools-denied"
        hint="One per line. Wins over allowed_tools."
      >
        <textarea
          id="tools-denied"
          aria-label="Denied tools"
          value={((base.denied_tools as string[]) ?? []).join('\n')}
          onChange={e => {
            const list = linesToList(e.target.value);
            onChange({ denied_tools: list.length ? list : null });
          }}
          rows={4}
          style={textareaStyle}
        />
      </Field>
      <JsonField
        label="Output format"
        value={base.output_format ?? {}}
        onChange={v => {
          onChange({ output_format: v && Object.keys(v as object).length ? v : null });
        }}
        hint="Free-form JSON shape Archon uses for typed step output."
      />
    </>
  );
}
