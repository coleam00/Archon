import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { HooksTab } from '../../../../components/inspector/tabs/HooksTab';

const renderTab = (
  base: Record<string, unknown>,
  onChange: (p: Record<string, unknown>) => void = () => {}
) =>
  render(
    <HooksTab
      id="n"
      data={undefined}
      base={base}
      unknown={{}}
      onChange={onChange}
      siblingIds={[]}
    />
  );

describe('HooksTab', () => {
  beforeEach(() => cleanup());

  it('renders a single Hooks JSON editor (per drift §8 — keyed-by-event schema)', () => {
    renderTab({});
    expect(screen.getByLabelText(/^hooks$/i)).toBeDefined();
  });

  it('round-trips an event-keyed hook map through the JSON editor', () => {
    let captured: Record<string, unknown> | undefined;
    const initial = {
      PreToolUse: [{ matcher: 'Bash', response: { decision: 'ask' } }],
    };
    renderTab({ hooks: initial }, p => {
      captured = p;
    });
    const ta = screen.getByLabelText(/^hooks$/i) as HTMLTextAreaElement;
    expect(JSON.parse(ta.value)).toEqual(initial);

    const next = {
      PreToolUse: [{ matcher: 'Bash', response: { decision: 'allow' } }],
      Stop: [{ response: { decision: 'block' } }],
    };
    fireEvent.change(ta, { target: { value: JSON.stringify(next) } });
    fireEvent.blur(ta);
    expect(captured).toEqual({ hooks: next });
  });

  it('emits hooks: null when the JSON object is empty', () => {
    let captured: Record<string, unknown> | undefined;
    renderTab({ hooks: { Stop: [{ response: {} }] } }, p => {
      captured = p;
    });
    const ta = screen.getByLabelText(/^hooks$/i);
    fireEvent.change(ta, { target: { value: '{}' } });
    fireEvent.blur(ta);
    expect(captured).toEqual({ hooks: null });
  });
});
