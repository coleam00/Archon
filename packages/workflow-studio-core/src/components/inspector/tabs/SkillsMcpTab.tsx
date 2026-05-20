import type { InspectorProps } from '../../../nodes/shared/types';
import { Field } from '../shared';
import { inputStyle, textareaStyle } from '../../../nodes/shared/inspectorStyles';

const linesToList = (s: string): string[] =>
  s
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

/**
 * Shared base-field tab for skill/mcp wiring.
 *
 * Schema reality (drift §8 listed `mcp` as a "list of server keys" — that's
 * not what the schema says): `skills` is `Array<string>` (must be non-empty
 * when present); `mcp` is a single string path to an mcp-config file.
 */
export function SkillsMcpTab({ base, onChange }: InspectorProps<unknown>): JSX.Element {
  return (
    <>
      <Field
        label="Skills"
        htmlFor="skills-list"
        hint="One per line. Names of skills available to this step."
      >
        <textarea
          id="skills-list"
          aria-label="Skills"
          value={((base.skills as string[]) ?? []).join('\n')}
          onChange={e => {
            const list = linesToList(e.target.value);
            onChange({ skills: list.length ? list : null });
          }}
          rows={4}
          style={textareaStyle}
        />
      </Field>
      <Field
        label="MCP config path"
        htmlFor="mcp-path"
        hint="Path to an mcp-config file. Empty = inherit workflow default."
      >
        <input
          id="mcp-path"
          aria-label="MCP config path"
          value={(base.mcp as string) ?? ''}
          onChange={e => {
            onChange({ mcp: e.target.value || null });
          }}
          style={inputStyle}
        />
      </Field>
    </>
  );
}
