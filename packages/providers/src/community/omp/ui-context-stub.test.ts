import { describe, expect, test } from 'bun:test';

import { createArchonOmpUIBridge, createArchonOmpUIContext } from './ui-context-stub';

describe('createArchonOmpUIContext', () => {
  test('custom resolves as a no-op like the default OMP UI context', async () => {
    const ctx = createArchonOmpUIContext(createArchonOmpUIBridge());

    await expect(ctx.custom()).resolves.toBeUndefined();
  });

  test('theme decorator helpers return identity decorators', () => {
    const ctx = createArchonOmpUIContext(createArchonOmpUIBridge());
    const theme = ctx.theme as Record<string, (level?: unknown) => (text: string) => string>;

    expect(theme.getThinkingBorderColor('low')('thinking')).toBe('thinking');
    expect(theme.getBashModeBorderColor('low')('bash')).toBe('bash');
    expect(theme.getWarningColor('low')('warning')).toBe('warning');
  });
});
