import { describe, it, expect, mock, spyOn, afterEach, beforeEach } from 'bun:test';
import type { MergedConfig } from '@archon/core';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers/in-process';
import {
  clearRegistry,
  getRegistration,
  providerRegistry,
  registerProvider,
  setDeprecationReporter,
} from '@archon/providers';
import { checkInstalledProviders, checkProviderDiagnostics } from './doctor-providers';
import { checkProviderDeprecation } from './doctor-config';
import { doctorCommand } from './doctor';

describe('provider diagnostics', () => {
  it('no registered providers fails and names the add command', async () => {
    const check = await checkInstalledProviders(
      { get: () => undefined, list: () => [] },
      async () => new Map()
    );
    expect(check.status).toBe('fail');
    expect(check.message).toContain(
      'No providers installed. Run: archon provider add <claude|codex|pi>'
    );
    expect(check.message).toContain('it does not install that CLI.');
    expect(await doctorCommand([async () => check])).toBe(1);
  });

  it('only deprecated bundled providers warns and names the add command', async () => {
    const { registerOpencodeProvider } = await import('@archon/providers/community/opencode');
    const { providerRegistry } = await import('@archon/providers');
    registerOpencodeProvider();
    const opencode = providerRegistry.get('opencode');
    if (!opencode) throw new Error('OpenCode did not register');
    const check = await checkInstalledProviders(
      { get: () => undefined, list: () => [opencode] },
      async () => new Map()
    );
    expect(check).toEqual({
      label: 'Installed providers',
      status: 'warn',
      message:
        'No providers installed. Run: archon provider add <claude|codex|pi>\n    ' +
        'Adding a provider connects Archon to your agent CLI or SDK; it does not install that CLI.',
    });
  });

  it('maps provider statuses, preserves remedies, and forwards its configured defaults', async () => {
    const diagnose = mock(async (_request: unknown) => ({
      checks: [
        { id: 'one', label: 'One', status: 'ok' as const, message: 'healthy' },
        { id: 'two', label: 'Two', status: 'fail' as const, message: 'broken', remedy: 'repair' },
        { id: 'three', label: 'Three', status: 'warn' as const, message: 'warning' },
        { id: 'four', label: 'Four', status: 'skip' as const, message: 'skipped' },
      ],
    }));
    const config = { assistants: { claude: {}, codex: {}, custom: { model: 'chosen' } } };
    const checks = await checkProviderDiagnostics('custom', { diagnose }, async () => config);
    expect(diagnose).toHaveBeenCalledWith({
      assistantConfig: { model: 'chosen' },
      signal: expect.any(AbortSignal),
    });
    expect(checks.map(check => check.status)).toEqual(['pass', 'fail', 'warn', 'skip']);
    expect(checks[1].message).toBe('broken Remedy: repair');
    const output = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await doctorCommand([async () => checks])).toBe(1);
      const rendered = output.mock.calls.flat().join('\n');
      expect(rendered).toContain('✓ custom: One: healthy');
      expect(rendered).toContain('✗ custom: Two: broken Remedy: repair');
      expect(rendered).toContain('! custom: Three: warning');
      expect(rendered).toContain('○ custom: Four: skipped');
    } finally {
      output.mockRestore();
    }
  });

  it('an unavailable diagnostic hook skips, while a hook failure fails with its evidence', async () => {
    expect((await checkProviderDiagnostics('custom', {}))[0].status).toBe('skip');
    const checks = await checkProviderDiagnostics(
      'custom',
      {
        diagnose: async () => {
          throw new Error('plugin failed');
        },
      },
      async () => ({ assistants: { claude: {}, codex: {} } })
    );
    expect(checks).toEqual([
      { label: 'custom diagnostics', status: 'fail', message: 'plugin failed' },
    ]);
  });
});

describe('bundled deprecated providers', () => {
  const diagnose = mock(async () => ({
    checks: [
      {
        id: 'runtime',
        label: 'Runtime',
        status: 'fail' as const,
        message: 'old executable not found on PATH',
      },
    ],
  }));
  const reportDeprecation = mock((_provider: string, _notice: string) => undefined);

  beforeEach(() => {
    clearRegistry();
    registerBuiltinProviders();
    registerCommunityProviders();
    const copilot = getRegistration('copilot');
    registerProvider({
      ...copilot,
      id: 'old',
      factory: () => Object.assign(copilot.factory(), { diagnose }),
    });
    setDeprecationReporter(reportDeprecation);
    diagnose.mockClear();
    reportDeprecation.mockClear();
  });

  afterEach(() => {
    clearRegistry();
  });

  it('a fresh install neither diagnoses one nor reports its notice', async () => {
    const checks = await checkProviderDiagnostics('old', undefined, async () => ({
      assistant: 'claude',
      assistants: { claude: {}, codex: {}, old: {} },
    }));
    expect(checks).toEqual([]);
    expect(diagnose).not.toHaveBeenCalled();
    expect(reportDeprecation).not.toHaveBeenCalled();
  });

  it.each(['old', 'copilot'])(
    'a config that fails to load selects no deprecated provider (%s)',
    async id => {
      const checks = await checkProviderDiagnostics(id, undefined, async () => {
        throw new Error('config.yaml: bad indentation');
      });
      expect(checks).toEqual([]);
      expect(diagnose).not.toHaveBeenCalled();
    }
  );

  const selections: {
    selection: string;
    config: Pick<MergedConfig, 'assistant' | 'assistants'>;
  }[] = [
    {
      selection: 'selected as the default assistant',
      config: { assistant: 'old', assistants: { claude: {}, codex: {} } },
    },
    {
      selection: 'configured under assistants',
      config: {
        assistant: 'claude',
        assistants: { claude: {}, codex: {}, old: { model: 'chosen' } },
      },
    },
  ];
  it.each(selections)(
    'a provider $selection still reports its missing runtime',
    async ({ config }) => {
      const checks = await checkProviderDiagnostics('old', undefined, async () => config);
      expect(checks).toEqual([
        { label: 'old: Runtime', status: 'fail', message: 'old executable not found on PATH' },
      ]);
      // Provider support shows the notice; a diagnostic is not a run and must not repeat it.
      expect(reportDeprecation).not.toHaveBeenCalled();
    }
  );

  it('the selected one shows its notice as readable text in Provider support', async () => {
    const check = await checkProviderDeprecation('/repo', async () => ({ assistant: 'opencode' }));
    expect(check).toEqual({
      label: 'Provider support',
      status: 'warn',
      message: getRegistration('opencode').deprecationNotice ?? '',
    });
    expect(check.message).toStartWith('OpenCode is deprecated');
  });

  it('the installed line names only installed providers', async () => {
    const check = await checkInstalledProviders(providerRegistry, async () => new Map());
    expect(check.status).toBe('pass');
    expect(check.message).toContain('claude');
    expect(check.message).not.toMatch(/opencode|copilot|old/);
  });
});

it('a diagnostic deadline fails with the caller evidence', async () => {
  const abort = new AbortController();
  abort.abort(new Error('diagnostic deadline'));
  const checks = await checkProviderDiagnostics(
    'custom',
    {
      diagnose: async ({ signal }) => {
        signal.throwIfAborted();
        return { checks: [] };
      },
    },
    async () => ({ assistants: { claude: {}, codex: {} } }),
    abort.signal
  );
  expect(checks).toEqual([
    { label: 'custom diagnostics', status: 'fail', message: 'diagnostic deadline' },
  ]);
});
