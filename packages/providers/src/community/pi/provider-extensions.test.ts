import {
  mockBindExtensions,
  mockSetFlagValue,
  MockDefaultResourceLoader,
  consume,
  resetScript,
  scriptedAgentEnd,
} from './provider-test-fixture';
import { describe, expect, test } from 'bun:test';
import { PiProvider } from './provider';
describe('PiProvider extensions', () => {
  test('extensions are enabled by default (noExtensions: false)', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    // Extensions (community packages and user-authored) are a core reason
    // users run Pi; off-by-default silently broke users who installed or
    // authored one and expected it to fire.
    expect(loaderArgs?.noExtensions).toBe(false);
    // Skills/prompts/themes stay suppressed. Context files follow Pi's native
    // default instead of an Archon-owned policy.
    expect(loaderArgs?.noSkills).toBe(true);
    expect(loaderArgs?.noPromptTemplates).toBe(true);
    expect(loaderArgs?.noThemes).toBe(true);
    expect(loaderArgs).not.toHaveProperty('noContextFiles');
  });

  test('assistantConfig.enableExtensions: true flips noExtensions to false', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { enableExtensions: true },
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.noExtensions).toBe(false);
    // Skills/prompts/themes stay suppressed. Context files follow Pi's native
    // default instead of the extension switch.
    expect(loaderArgs?.noSkills).toBe(true);
    expect(loaderArgs?.noPromptTemplates).toBe(true);
    expect(loaderArgs?.noThemes).toBe(true);
    expect(loaderArgs).not.toHaveProperty('noContextFiles');
  });

  test('assistantConfig.enableExtensions: false keeps noExtensions: true', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { enableExtensions: false },
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.noExtensions).toBe(true);
  });

  test('interactive: true with enableExtensions binds a UIContext to the session', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { enableExtensions: true, interactive: true },
      })
    );

    expect(mockBindExtensions).toHaveBeenCalledTimes(1);
    const [bindings] = mockBindExtensions.mock.calls[0] as [{ uiContext?: unknown }];
    expect(bindings.uiContext).toBeDefined();
  });

  test('enableExtensions: false disables binding even if interactive: true is set', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { enableExtensions: false, interactive: true },
      })
    );

    expect(mockBindExtensions).not.toHaveBeenCalled();
  });

  test('interactive: false with extensions on binds empty (session_start fires, no UIContext)', async () => {
    // When extensions are loaded, session_start MUST fire so each extension's
    // startup handler runs (reads flags, registers tools, etc.). Binding with
    // no uiContext keeps Pi's internal noOpUIContext active so hasUI stays
    // false — extensions that gate UI flows (like plannotator) will auto-approve
    // in this mode.
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { interactive: false },
      })
    );

    expect(mockBindExtensions).toHaveBeenCalledTimes(1);
    const [bindings] = mockBindExtensions.mock.calls[0] as [{ uiContext?: unknown }];
    expect(bindings.uiContext).toBeUndefined();
  });

  test('default (nothing set) binds with UIContext — extensions + interactive both on', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    expect(mockBindExtensions).toHaveBeenCalledTimes(1);
    const [bindings] = mockBindExtensions.mock.calls[0] as [{ uiContext?: unknown }];
    expect(bindings.uiContext).toBeDefined();
  });

  test('extensionFlags sets flag values before bindExtensions fires session_start', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    // Track call order: setFlagValue must run BEFORE bindExtensions, else
    // extensions reading flags in their session_start handler miss them.
    const callOrder: string[] = [];
    mockSetFlagValue.mockImplementationOnce(() => {
      callOrder.push('setFlagValue');
      return undefined;
    });
    mockSetFlagValue.mockImplementationOnce(() => {
      callOrder.push('setFlagValue');
      return undefined;
    });
    mockBindExtensions.mockImplementationOnce(async () => {
      callOrder.push('bindExtensions');
    });

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: {
          enableExtensions: true,
          interactive: true,
          extensionFlags: { plan: true, 'plan-file': 'PLAN.md' },
        },
      })
    );

    expect(mockSetFlagValue).toHaveBeenCalledTimes(2);
    expect(mockSetFlagValue).toHaveBeenCalledWith('plan', true);
    expect(mockSetFlagValue).toHaveBeenCalledWith('plan-file', 'PLAN.md');
    expect(callOrder).toEqual(['setFlagValue', 'setFlagValue', 'bindExtensions']);
  });

  test('extensionFlags is a no-op when enableExtensions is explicitly false', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { enableExtensions: false, extensionFlags: { plan: true } },
      })
    );

    expect(mockSetFlagValue).not.toHaveBeenCalled();
    expect(mockBindExtensions).not.toHaveBeenCalled();
  });

  test('node override drops UIContext and negates the plan flag for that node', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: {
          enableExtensions: true,
          interactive: true,
          extensionFlags: { plan: true },
          nodes: { implement: { interactive: false, extensionFlags: { plan: false } } },
        },
        nodeConfig: { nodeId: 'implement' },
      })
    );

    // Extensions still load (session_start must fire) but with no UIContext —
    // hasUI stays false so plannotator won't open its blocking review server.
    expect(mockBindExtensions).toHaveBeenCalledTimes(1);
    const [bindings] = mockBindExtensions.mock.calls[0] as [{ uiContext?: unknown }];
    expect(bindings.uiContext).toBeUndefined();
    // Merged flags: node-level plan: false wins over assistant-level plan: true.
    expect(mockSetFlagValue).toHaveBeenCalledTimes(1);
    expect(mockSetFlagValue).toHaveBeenCalledWith('plan', false);
  });

  test('node without an override keeps assistant-level UIContext and flags', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: {
          enableExtensions: true,
          interactive: true,
          extensionFlags: { plan: true },
          nodes: { implement: { interactive: false, extensionFlags: { plan: false } } },
        },
        nodeConfig: { nodeId: 'plan' },
      })
    );

    expect(mockBindExtensions).toHaveBeenCalledTimes(1);
    const [bindings] = mockBindExtensions.mock.calls[0] as [{ uiContext?: unknown }];
    expect(bindings.uiContext).toBeDefined();
    expect(mockSetFlagValue).toHaveBeenCalledTimes(1);
    expect(mockSetFlagValue).toHaveBeenCalledWith('plan', true);
  });

  test('direct chat (no nodeConfig) ignores nodes overrides', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: {
          interactive: true,
          nodes: { implement: { interactive: false } },
        },
      })
    );

    expect(mockBindExtensions).toHaveBeenCalledTimes(1);
    const [bindings] = mockBindExtensions.mock.calls[0] as [{ uiContext?: unknown }];
    expect(bindings.uiContext).toBeDefined();
  });

  test('node enableExtensions: false skips binding entirely for that node', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: {
          enableExtensions: true,
          interactive: true,
          extensionFlags: { plan: true },
          nodes: { implement: { enableExtensions: false } },
        },
        nodeConfig: { nodeId: 'implement' },
      })
    );

    expect(mockBindExtensions).not.toHaveBeenCalled();
    expect(mockSetFlagValue).not.toHaveBeenCalled();
  });

  test('node-YAML pi overrides the config nodes.<id> map (drops UI, negates plan)', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: {
          enableExtensions: true,
          interactive: true,
          extensionFlags: { plan: true },
          // config map says implement is UI-on with plan: true …
          nodes: { implement: { interactive: true, extensionFlags: { plan: true } } },
        },
        // … but the portable node-YAML block wins and turns it headless.
        nodeConfig: {
          nodeId: 'implement',
          pi: { interactive: false, extensionFlags: { plan: false } },
        },
      })
    );

    expect(mockBindExtensions).toHaveBeenCalledTimes(1);
    const [bindings] = mockBindExtensions.mock.calls[0] as [{ uiContext?: unknown }];
    expect(bindings.uiContext).toBeUndefined();
    expect(mockSetFlagValue).toHaveBeenCalledTimes(1);
    expect(mockSetFlagValue).toHaveBeenCalledWith('plan', false);
  });

  test('node-YAML pi grants posture with no config nodes map present', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { enableExtensions: true, interactive: false },
        // No nodes map; the node's own pi: block re-enables the UI bridge and grants plan.
        nodeConfig: { nodeId: 'plan', pi: { interactive: true, extensionFlags: { plan: true } } },
      })
    );

    expect(mockBindExtensions).toHaveBeenCalledTimes(1);
    const [bindings] = mockBindExtensions.mock.calls[0] as [{ uiContext?: unknown }];
    expect(bindings.uiContext).toBeDefined();
    expect(mockSetFlagValue).toHaveBeenCalledTimes(1);
    expect(mockSetFlagValue).toHaveBeenCalledWith('plan', true);
  });

  test('node-YAML pi enableExtensions: false skips binding even when the config map re-enables', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: {
          enableExtensions: true,
          interactive: true,
          nodes: { implement: { enableExtensions: true, interactive: true } },
        },
        nodeConfig: { nodeId: 'implement', pi: { enableExtensions: false } },
      })
    );

    expect(mockBindExtensions).not.toHaveBeenCalled();
    expect(mockSetFlagValue).not.toHaveBeenCalled();
  });
});
