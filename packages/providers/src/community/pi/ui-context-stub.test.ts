import { describe, expect, test } from 'bun:test';

import type { MessageChunk } from '../../types';

import { createArchonUIBridge, createArchonUIContext } from './ui-context-stub';

describe('createArchonUIBridge', () => {
  test('drops notifications when no emitter is set', () => {
    const bridge = createArchonUIBridge();
    expect(() => bridge.emit({ type: 'system', content: 'x' })).not.toThrow();
  });

  test('forwards notifications to the configured emitter', () => {
    const bridge = createArchonUIBridge();
    const chunks: MessageChunk[] = [];
    bridge.setEmitter(c => chunks.push(c));
    bridge.emit({ type: 'system', content: 'hello' });
    expect(chunks).toEqual([{ type: 'system', content: 'hello' }]);
  });

  test('detaches emitter when cleared (bridgeSession cleanup path)', () => {
    const bridge = createArchonUIBridge();
    const chunks: MessageChunk[] = [];
    bridge.setEmitter(c => chunks.push(c));
    bridge.setEmitter(undefined);
    bridge.emit({ type: 'system', content: 'late' });
    expect(chunks).toEqual([]);
  });
});

describe('createArchonUIContext', () => {
  function mk() {
    const bridge = createArchonUIBridge();
    const chunks: MessageChunk[] = [];
    bridge.setEmitter(c => chunks.push(c));
    const ui = createArchonUIContext(bridge);
    return { ui, chunks };
  }

  test('notify("info") forwards as assistant chunk with info glyph (captured in nodeOutput)', () => {
    const { ui, chunks } = mk();
    ui.notify('Remote session. Open: http://host:8080/', 'info');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({
      type: 'assistant',
      content: '\n[pi extension ℹ️] Remote session. Open: http://host:8080/\n',
    });
  });

  test('notify defaults to info when type omitted', () => {
    const { ui, chunks } = mk();
    ui.notify('bare message');
    expect(chunks[0]?.content).toBe('\n[pi extension ℹ️] bare message\n');
  });

  test('notify("warning") and notify("error") use distinct glyphs', () => {
    const { ui, chunks } = mk();
    ui.notify('soft', 'warning');
    ui.notify('hard', 'error');
    expect(chunks[0]?.content).toBe('\n[pi extension ⚠️] soft\n');
    expect(chunks[1]?.content).toBe('\n[pi extension ❌] hard\n');
  });

  test('select resolves to undefined (no operator to answer)', async () => {
    const { ui } = mk();
    await expect(ui.select('pick', ['a', 'b'])).resolves.toBeUndefined();
  });

  test('confirm resolves to false', async () => {
    const { ui } = mk();
    await expect(ui.confirm('are you sure?', 'really')).resolves.toBe(false);
  });

  test('input and editor resolve to undefined', async () => {
    const { ui } = mk();
    await expect(ui.input('title')).resolves.toBeUndefined();
    await expect(ui.editor('title', 'prefill')).resolves.toBeUndefined();
  });

  test('custom resolves to undefined-cast', async () => {
    const { ui } = mk();
    const res = await ui.custom(() => ({}) as never);
    expect(res).toBeUndefined();
  });

  test('getEditorText returns empty string', () => {
    const { ui } = mk();
    expect(ui.getEditorText()).toBe('');
  });

  test('getToolsExpanded returns false', () => {
    const { ui } = mk();
    expect(ui.getToolsExpanded()).toBe(false);
  });

  test('getAllThemes returns empty list and getTheme returns undefined', () => {
    const { ui } = mk();
    expect(ui.getAllThemes()).toEqual([]);
    expect(ui.getTheme('anything')).toBeUndefined();
  });

  test('setTheme returns failure result without throwing', () => {
    const { ui } = mk();
    const result = ui.setTheme('dark');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test('theme getter returns a proxy that throws on property access', () => {
    const { ui } = mk();
    const themeRef = ui.theme;
    expect(() => themeRef.fg('accent', 'text')).toThrow(/Archon's remote UI stub/);
  });

  test('onTerminalInput returns a disposer that is safe to call', () => {
    const { ui } = mk();
    const dispose = ui.onTerminalInput(() => undefined);
    expect(() => dispose()).not.toThrow();
  });

  test('TUI setters (setStatus/setWidget/setFooter/setHeader/setTitle) are no-ops', () => {
    const { ui, chunks } = mk();
    expect(() => ui.setStatus('k', 'v')).not.toThrow();
    expect(() => ui.setWidget('k', ['line'])).not.toThrow();
    expect(() => ui.setFooter(undefined)).not.toThrow();
    expect(() => ui.setHeader(undefined)).not.toThrow();
    expect(() => ui.setTitle('title')).not.toThrow();
    expect(() => ui.setWorkingMessage('working')).not.toThrow();
    expect(() => ui.setHiddenThinkingLabel('label')).not.toThrow();
    expect(() => ui.pasteToEditor('text')).not.toThrow();
    expect(() => ui.setEditorText('text')).not.toThrow();
    expect(() => ui.setEditorComponent(undefined)).not.toThrow();
    expect(() => ui.setToolsExpanded(true)).not.toThrow();
    expect(chunks).toEqual([]);
  });
});
