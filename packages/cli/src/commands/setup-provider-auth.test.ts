import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { tmpdir } from 'os';
import * as prompts from '@clack/prompts';
import { removeTempTree } from '@archon/paths/test-utils';
import { listPiModels, PiProvider } from '@archon/providers/community/pi';
import {
  collectPiConfig,
  detectClaudeExecutablePath,
  PI_BACKENDS,
  PI_DEFAULT_MODELS,
  piBackendEnvVar,
  writeHomePiModelConfig,
} from './setup-provider-auth';
import * as providerAuth from './setup-provider-auth';

describe('detectClaudeExecutablePath probe order', () => {
  // Use spies on the exported probe wrappers so each tier can be controlled
  // independently without touching the real filesystem or shell.
  let fileExistsSpy: ReturnType<typeof spyOn>;
  let npmRootSpy: ReturnType<typeof spyOn>;
  let whichSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fileExistsSpy = spyOn(providerAuth, 'probeFileExists').mockReturnValue(false);
    npmRootSpy = spyOn(providerAuth, 'probeNpmRoot').mockReturnValue(null);
    whichSpy = spyOn(providerAuth, 'probeWhichClaude').mockReturnValue(null);
  });

  afterEach(() => {
    fileExistsSpy.mockRestore();
    npmRootSpy.mockRestore();
    whichSpy.mockRestore();
  });

  it('returns the native installer path when present (tier 1 wins)', () => {
    // Native path exists; subsequent probes must not be called.
    fileExistsSpy.mockImplementation(
      (p: string) => p.includes('.local/bin/claude') || p.includes('.local\\bin\\claude')
    );
    const result = detectClaudeExecutablePath();
    expect(result).toBeTruthy();
    expect(result).toMatch(/\.local[\\/]bin[\\/]claude/);
    // Tier 2 / 3 must not have been consulted.
    expect(npmRootSpy).not.toHaveBeenCalled();
    expect(whichSpy).not.toHaveBeenCalled();
  });

  it('falls through to npm cli.js when native is missing (tier 2 wins)', () => {
    // Use path.join so the expected result matches whatever separator the
    // production code produces on the current platform (backslash on Windows,
    // forward slash elsewhere).
    const npmRoot = join('fake', 'npm', 'root');
    const expectedCliJs = join(npmRoot, '@anthropic-ai', 'claude-code', 'cli.js');
    npmRootSpy.mockReturnValue(npmRoot);
    fileExistsSpy.mockImplementation((p: string) => p === expectedCliJs);
    const result = detectClaudeExecutablePath();
    expect(result).toBe(expectedCliJs);
    // Tier 3 must not have been consulted.
    expect(whichSpy).not.toHaveBeenCalled();
  });

  it('falls through to which/where when native and npm probes both miss (tier 3 wins)', () => {
    npmRootSpy.mockReturnValue('/fake/npm/root');
    // Native miss, npm cli.js miss, but `which claude` returns a path that exists.
    whichSpy.mockReturnValue('/opt/homebrew/bin/claude');
    fileExistsSpy.mockImplementation((p: string) => p === '/opt/homebrew/bin/claude');
    const result = detectClaudeExecutablePath();
    expect(result).toBe('/opt/homebrew/bin/claude');
  });

  it('returns null when every probe misses', () => {
    // All defaults already return false/null; nothing to override.
    expect(detectClaudeExecutablePath()).toBeNull();
  });

  it('does not return a which-resolved path that fails the existsSync check', () => {
    // `which` returns a path string but the file is not actually present
    // (stale PATH entry, dangling symlink, etc.) — must not be returned.
    npmRootSpy.mockReturnValue('/fake/npm/root');
    whichSpy.mockReturnValue('/stale/path/claude');
    fileExistsSpy.mockReturnValue(false);
    expect(detectClaudeExecutablePath()).toBeNull();
  });

  it('skips npm tier when probeNpmRoot returns null (e.g. npm not installed)', () => {
    // npm probe fails; tier 3 must still run.
    whichSpy.mockReturnValue('/usr/local/bin/claude');
    fileExistsSpy.mockImplementation((p: string) => p === '/usr/local/bin/claude');
    const result = detectClaudeExecutablePath();
    expect(result).toBe('/usr/local/bin/claude');
    expect(npmRootSpy).toHaveBeenCalled();
  });
});

describe('writeHomePiModelConfig', () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archon-pi-config-'));
    originalHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = tmpDir;
  });

  afterEach(async () => {
    await removeTempTree(tmpDir);
    if (originalHome !== undefined) {
      process.env.ARCHON_HOME = originalHome;
    } else {
      delete process.env.ARCHON_HOME;
    }
  });

  const configPath = (): string => join(tmpDir, 'config.yaml');
  const piModel = (): unknown => parse(readFileSync(configPath(), 'utf-8'))?.assistants?.pi?.model;
  const spies: { mockRestore(): void }[] = [];
  // Any select rejects unless a test answers it, so an unexpected prompt fails the test.
  function answer(...choices: string[]): ReturnType<typeof spyOn> {
    const select = spyOn(prompts, 'select').mockRejectedValue(new Error('unexpected select'));
    for (const choice of choices) select.mockResolvedValueOnce(choice);
    spies.push(select);
    return select;
  }
  beforeEach(() => answer());
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  it('writes the model when config.yaml does not exist yet', async () => {
    await writeHomePiModelConfig('openai/gpt-4o');
    expect(existsSync(configPath())).toBe(true);
    expect(piModel()).toBe('openai/gpt-4o');
  });

  it('writes the model when config.yaml has only comments', async () => {
    writeFileSync(configPath(), '# Archon\n# assistants:\n#   claude: x\n');
    await writeHomePiModelConfig('anthropic/claude-haiku-4-5');
    const content = readFileSync(configPath(), 'utf-8');
    expect(content).toContain('# assistants:');
    expect(piModel()).toBe('anthropic/claude-haiku-4-5');
  });

  it('adds Pi to an assistants block that has no Pi entry, keeping the rest', async () => {
    writeFileSync(
      configPath(),
      '# top\nbotName: Bot\nassistants:\n  claude:\n    model: sonnet # keep me\n'
    );
    await writeHomePiModelConfig('xai/grok-4.7');
    const content = readFileSync(configPath(), 'utf-8');
    expect(content).toContain('# top');
    expect(content).toContain('model: sonnet # keep me');
    expect(parse(content)).toEqual({
      botName: 'Bot',
      assistants: { claude: { model: 'sonnet' }, pi: { model: 'xai/grok-4.7' } },
    });
  });

  it('asks before replacing a different Pi model and keeps it when told to', async () => {
    writeFileSync(
      configPath(),
      'assistants:\n  pi:\n    model: old\n    enableExtensions: false\n'
    );
    const select = answer('keep');
    await writeHomePiModelConfig('xai/grok-4.7');
    expect(select).toHaveBeenCalledTimes(1);
    expect(piModel()).toBe('old');
  });

  it('defaults to keeping a saved model for the same backend', async () => {
    writeFileSync(configPath(), 'assistants:\n  pi:\n    model: xai/grok-4.5\n');
    const select = answer('keep');
    await writeHomePiModelConfig('xai/grok-4.7');
    expect(select.mock.calls[0]?.[0]).toMatchObject({ initialValue: 'keep' });
  });

  it('defaults to switching when the saved model is for another backend', async () => {
    writeFileSync(configPath(), 'assistants:\n  pi:\n    model: anthropic/claude-haiku-4-5\n');
    const select = answer('switch');
    await writeHomePiModelConfig('xai/grok-4.7');
    expect(select.mock.calls[0]?.[0]).toMatchObject({ initialValue: 'switch' });
    expect(piModel()).toBe('xai/grok-4.7');
  });

  it('replaces a different Pi model when the user switches, keeping its other settings', async () => {
    writeFileSync(
      configPath(),
      'assistants:\n  pi:\n    model: old\n    enableExtensions: false\n'
    );
    answer('switch');
    await writeHomePiModelConfig('xai/grok-4.7');
    expect(parse(readFileSync(configPath(), 'utf-8'))).toEqual({
      assistants: { pi: { model: 'xai/grok-4.7', enableExtensions: false } },
    });
  });

  it('does not ask when the Pi model already matches', async () => {
    writeFileSync(configPath(), 'assistants:\n  pi:\n    model: xai/grok-4.7\n');
    await writeHomePiModelConfig('xai/grok-4.7');
    expect(piModel()).toBe('xai/grok-4.7');
  });

  it('edits a flow-style config written by `archon ai tier set`', async () => {
    writeFileSync(configPath(), '{defaultAssistant: pi,tiers: {large: {provider: pi,model: x/y}}}');
    await writeHomePiModelConfig('xai/grok-4.7');
    expect(parse(readFileSync(configPath(), 'utf-8'))).toEqual({
      defaultAssistant: 'pi',
      tiers: { large: { provider: 'pi', model: 'x/y' } },
      assistants: { pi: { model: 'xai/grok-4.7' } },
    });
  });

  it('leaves a config.yaml it cannot parse untouched', async () => {
    const broken = 'assistants: [unclosed\n';
    writeFileSync(configPath(), broken);
    await writeHomePiModelConfig('xai/grok-4.7');
    expect(readFileSync(configPath(), 'utf-8')).toBe(broken);
  });

  it('keeps a model name with double quotes intact', async () => {
    await writeHomePiModelConfig('vendor/"weird-model"');
    expect(piModel()).toBe('vendor/"weird-model"');
  });
});

describe('Pi backend key variables', () => {
  it("saves a default model from Pi's built-in catalog for every backend", async () => {
    // An empty Pi directory, so only the built-in catalog counts, not a user's models.json.
    // listPiModels caches for the process, so this must stay its first caller in the group.
    const piDir = mkdtempSync(join(tmpdir(), 'archon-setup-pi-catalog-'));
    const savedDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = piDir;
    try {
      const catalog = new Set(
        (await listPiModels(new AbortController().signal)).map(model => model.ref)
      );
      // listPiModels returns [] on failure; an empty catalog would pass every check below.
      expect(catalog.size).toBeGreaterThan(0);
      const missing = PI_BACKENDS.map(backend => PI_DEFAULT_MODELS[backend.id]).filter(
        model => !catalog.has(model ?? '')
      );
      expect(missing).toEqual([]);
    } finally {
      if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedDir;
      await removeTempTree(piDir);
    }
  });

  it('has a key variable from Pi for every backend setup offers', () => {
    for (const backend of PI_BACKENDS) expect(() => piBackendEnvVar(backend.id)).not.toThrow();
    expect(piBackendEnvVar('huggingface')).toBe('HF_TOKEN');
  });

  it('asks for HF_TOKEN when the backend is Hugging Face', async () => {
    const select = spyOn(prompts, 'select')
      .mockRejectedValue(new Error('unexpected select'))
      .mockResolvedValueOnce('huggingface')
      .mockResolvedValueOnce('apiKey');
    const password = spyOn(prompts, 'password').mockResolvedValue('hf-key');
    try {
      expect(await collectPiConfig()).toMatchObject({ apiKey: 'hf-key', apiKeyEnvVar: 'HF_TOKEN' });
    } finally {
      select.mockRestore();
      password.mockRestore();
    }
  });
});

describe('collectPiConfig', () => {
  const spies: { mockRestore(): void }[] = [];

  // Answers the backend question with xAI, then the auth question with `auth`.
  // Any further select rejects, so a new question fails the test instead of
  // opening a real prompt.
  function answer(auth: 'piLogin' | 'apiKey'): void {
    spies.push(
      spyOn(prompts, 'select')
        .mockRejectedValue(new Error('unexpected select'))
        .mockResolvedValueOnce('xai')
        .mockResolvedValueOnce(auth)
    );
  }

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  it('skips the key prompt and writes no key when Pi already has a login', async () => {
    answer('piLogin');
    // Resolves instead of opening a real prompt, so a regression fails fast.
    const password = spyOn(prompts, 'password').mockResolvedValue('');
    spies.push(password);

    expect(await collectPiConfig()).toEqual({
      model: 'xai/grok-4.7',
      apiKeyEnvVar: 'XAI_API_KEY',
      piLogin: true,
    });
    expect(password).not.toHaveBeenCalled();
  });

  it("leaves the chosen model to Pi's stored login for that backend", async () => {
    const piDir = mkdtempSync(join(tmpdir(), 'archon-setup-pi-login-'));
    const envKeys = ['PI_CODING_AGENT_DIR', 'ARCHON_PI_AUTH_PATH', 'OPENROUTER_API_KEY'] as const;
    const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    try {
      for (const key of envKeys) delete process.env[key];
      process.env.PI_CODING_AGENT_DIR = piDir;
      // The entry Pi's OpenRouter login writes.
      writeFileSync(
        join(piDir, 'auth.json'),
        JSON.stringify({
          openrouter: {
            type: 'oauth',
            access: 'stored',
            refresh: '',
            expires: Number.MAX_SAFE_INTEGER,
          },
        })
      );
      spies.push(
        spyOn(prompts, 'select')
          .mockRejectedValue(new Error('unexpected select'))
          .mockResolvedValueOnce('openrouter')
          .mockResolvedValueOnce('piLogin')
      );
      const password = spyOn(prompts, 'password').mockResolvedValue('');
      spies.push(password);

      const config = await collectPiConfig();
      expect(config).toEqual({
        model: 'openrouter/qwen/qwen3-coder',
        apiKeyEnvVar: 'OPENROUTER_API_KEY',
        piLogin: true,
      });
      expect(password).not.toHaveBeenCalled();
      expect(
        await new PiProvider().checkCredential({
          model: config.model,
          env: {},
          signal: new AbortController().signal,
        })
      ).toEqual({ state: 'usable', source: 'native' });
    } finally {
      for (const key of envKeys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      await removeTempTree(piDir);
    }
  });

  it('returns the key and its env var when the user provides one', async () => {
    answer('apiKey');
    spies.push(spyOn(prompts, 'password').mockResolvedValue('  xai-key  '));

    expect(await collectPiConfig()).toEqual({
      model: 'xai/grok-4.7',
      apiKey: 'xai-key',
      apiKeyEnvVar: 'XAI_API_KEY',
      piLogin: false,
    });
  });

  it('hints that a Claude subscription login through Pi is not supported', async () => {
    const select = spyOn(prompts, 'select')
      .mockRejectedValue(new Error('unexpected select'))
      .mockResolvedValueOnce('anthropic')
      .mockResolvedValueOnce('piLogin');
    spies.push(select);

    expect(await collectPiConfig()).toEqual({
      model: 'anthropic/claude-haiku-4-5',
      apiKeyEnvVar: 'ANTHROPIC_API_KEY',
      piLogin: true,
    });
    const authQuestion = select.mock.calls[1]?.[0] as {
      options: { value: string; hint?: string }[];
    };
    const piLogin = authQuestion.options.find(o => o.value === 'piLogin');
    expect(piLogin?.hint).toContain('`provider: claude`');
  });

  it('treats an empty key as skipped instead of crashing', async () => {
    answer('apiKey');
    // clack 1.x resolves `undefined` when Enter is pressed on an empty password.
    spies.push(spyOn(prompts, 'password').mockResolvedValue(undefined as unknown as string));

    expect(await collectPiConfig()).toEqual({
      model: 'xai/grok-4.7',
      apiKeyEnvVar: 'XAI_API_KEY',
      piLogin: false,
    });
  });
});
