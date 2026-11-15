/**
 * Tests for setup command utility functions
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { bootstrapProjectConfig, configureDocsPath, setupCommand } from './setup';
import { collectAIConfig } from './setup-ai';
import * as setupAi from './setup-ai';
import * as providerAuth from './setup-provider-auth';
import * as doctorModule from './doctor';
import * as prompts from '@clack/prompts';
import * as platformRegistry from '@archon/core/platforms/registry';
import { removeTempTree } from '@archon/paths/test-utils';
import { loadRepoConfig } from '@archon/core/config/config-loader';
import { collectPlatforms } from './setup-platforms';
import { parse as parseDotenv } from 'dotenv';

describe('setup platform selection', () => {
  it.each(
    [
      [],
      ['github'],
      ['telegram'],
      ['slack'],
      ['github', 'telegram'],
      ['github', 'slack'],
      ['telegram', 'slack'],
      ['github', 'telegram', 'slack'],
    ].map(selected => ({ selected }))
  )('collects the selected platforms: %j', async ({ selected }) => {
    const selection = spyOn(prompts, 'multiselect').mockResolvedValue(selected);
    try {
      expect(await collectPlatforms()).toEqual({
        github: selected.includes('github'),
        telegram: selected.includes('telegram'),
        slack: selected.includes('slack'),
      });
      expect(selection).toHaveBeenCalledWith({
        message:
          'Which chat adapters do you want to connect? (all optional — Archon works as CLI + skill without any)\n(↑↓ navigate, space select, enter confirm)',
        options: [
          { value: 'github', label: 'GitHub', hint: 'Respond to issues/PRs via webhooks' },
          { value: 'telegram', label: 'Telegram', hint: 'Chat bot via BotFather' },
          { value: 'slack', label: 'Slack', hint: 'Workspace app with Socket Mode' },
        ],
        required: false,
      });
    } finally {
      selection.mockRestore();
    }
  });
});

// Test directory for file operations
const TEST_DIR = join(tmpdir(), 'archon-setup-test-' + Date.now());

describe('setup command', () => {
  beforeEach(() => {
    // Create test directory
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(TEST_DIR);
  });

  describe('configureDocsPath', () => {
    beforeEach(() => {
      spyOn(prompts, 'confirm').mockResolvedValue(true);
      spyOn(prompts, 'text').mockResolvedValue('docs/');
      spyOn(prompts, 'note').mockImplementation(() => undefined);
    });

    afterEach(() => {
      mock.restore();
    });

    it('writes the docs path after bootstrap while preserving the template', async () => {
      const { path } = bootstrapProjectConfig(TEST_DIR);
      const template = readFileSync(path, 'utf-8');

      await configureDocsPath(TEST_DIR);

      const written = readFileSync(path, 'utf-8');
      expect(written.startsWith(template)).toBe(true);
      expect(written).toContain('#   docs:');
      expect(Bun.YAML.parse(written)).toEqual({ docs: { path: 'docs/' } });
      expect(prompts.note).not.toHaveBeenCalled();
    });

    it.each([
      'docs:\n  path: existing/\n',
      '"docs": null\n',
      'docs: null\ndocs: null\n',
      '{docs: {path: existing/}}\n',
      'docs:\n  path: existing/\n...\n',
      'key: &key docs\n*key : {path: existing/}\n',
      '? [docs]\n: {path: existing/}\n',
      'defaults: &defaults {docs: {path: existing/}}\n<<: *defaults\n',
      '%YAML 1.1\n---\ndefaults: &defaults {docs: {path: existing/}}\n<<: *defaults\n',
      'defaults: &defaults {docs: {path: existing/}}\n<<: [*defaults]\n',
      '<<: {docs: {path: existing/}}\n',
      '!!str docs: {path: existing/}\n',
      '? >-\n  docs\n: {path: existing/}\n',
      'defaults: &defaults {docs: {path: inherited/}}\n<<: *defaults\ndocs: {path: existing/}\n',
    ])('preserves an active docs key and asks for a manual edit: %s', async docs => {
      const { path } = bootstrapProjectConfig(TEST_DIR);
      const existing = readFileSync(path, 'utf-8') + docs;
      writeFileSync(path, existing);

      await configureDocsPath(TEST_DIR);

      expect(readFileSync(path, 'utf-8')).toBe(existing);
      expect(prompts.note).toHaveBeenCalledWith(
        `A "docs:" key already exists in ${path}.\nEdit it manually to set path: docs/`,
        'Docs path not written'
      );
    });

    it('preserves other settings and comments containing docs:', async () => {
      const { path } = bootstrapProjectConfig(TEST_DIR);
      const existing = '# docs: example\nassistants:\n  claude:\n    model: opus\n';
      writeFileSync(path, existing);

      await configureDocsPath(TEST_DIR);

      const written = readFileSync(path, 'utf-8');
      expect(written.startsWith(existing)).toBe(true);
      expect(Bun.YAML.parse(written)).toEqual({
        assistants: { claude: { model: 'opus' } },
        docs: { path: 'docs/' },
      });
    });

    it.each(['docs\\team', 'docs\\guide', 'docs/"quoted"', 'docs/line\nbreak'])(
      'round-trips the selected path through the repository loader: %s',
      async docsPath => {
        bootstrapProjectConfig(TEST_DIR);
        spyOn(prompts, 'text').mockResolvedValue(docsPath);

        await configureDocsPath(TEST_DIR);

        expect((await loadRepoConfig(TEST_DIR)).docs?.path).toBe(docsPath);
      }
    );

    it.each([
      '# docs: example\n{assistants: {claude: {model: opus}}}\n',
      '# docs: example\n{assistants: {claude: {model: opus}},} # trailing comment\n',
      '# docs: example\nassistants:\n  claude:\n    model: opus\n...\n# after document\n',
      '# docs: example\nassistants:\n  claude:\n    model: opus\n',
      'assistants: {}\nassistants: {claude: {model: opus}}\n',
      'key: &key other\n*key : value\n',
      '? [other]\n: value\n',
      '? {other: key}\n: value\n',
      '# docs: example\n',
      '',
      '%YAML 1.1\n---\nassistants:\n  claude:\n    model: opus\n',
      '%YAML 1.1\n---\n{assistants: {claude: {model: opus}}}\n',
      '%YAML 1.1\n---\nassistants: {claude: {model: opus}}\n',
      '%YAML 1.1\n---\nassistants:\n  claude:\n    model: opus\n...\n',
      '%YAML 1.2\n---\nassistants: {claude: {model: opus}}\n',
      '!!map {assistants: {claude: {model: opus}}}\n',
      '---\n',
      '---\n# empty\n',
      '---\n# empty\n...\n# after document\n',
      'null # empty\n',
      '~ # empty\n',
      '!!null null # empty\n',
      '%YAML 1.1\n---\n# empty\n',
      '%YAML 1.2\n---\n# empty\n',
    ])('adds docs within the existing YAML document: %j', async existing => {
      const { path } = bootstrapProjectConfig(TEST_DIR);
      writeFileSync(path, existing);
      const before = await loadRepoConfig(TEST_DIR);

      await configureDocsPath(TEST_DIR);

      expect(await loadRepoConfig(TEST_DIR)).toEqual({ ...before, docs: { path: 'docs/' } });
      const written = readFileSync(path, 'utf-8');
      for (const line of existing.split('\n')) {
        const comment = line.indexOf('#');
        if (comment !== -1) expect(written).toContain(line.slice(comment));
        if (line.startsWith('%YAML')) expect(written).toContain(line);
      }
    });

    it('reports malformed YAML without changing the file', async () => {
      const { path } = bootstrapProjectConfig(TEST_DIR);
      const existing = 'assistants: [\n';
      writeFileSync(path, existing);
      const cancel = spyOn(prompts, 'cancel').mockImplementation(() => undefined);

      await expect(configureDocsPath(TEST_DIR)).rejects.toMatchObject({ exitCode: 1 });

      expect(readFileSync(path, 'utf-8')).toBe(existing);
      expect(cancel).toHaveBeenCalledWith(expect.stringContaining('Could not write docs config:'));
    });
  });

  describe('bootstrapProjectConfig', () => {
    it('creates .archon/config.yaml when it does not exist', () => {
      const target = join(TEST_DIR, 'bootstrap-target');
      mkdirSync(target, { recursive: true });

      const result = bootstrapProjectConfig(target);

      expect(result.state).toBe('created');
      expect(result.path).toBe(join(target, '.archon', 'config.yaml'));
      expect(existsSync(result.path)).toBe(true);
      const content = readFileSync(result.path, 'utf-8');
      // Must be valid YAML — comment lines only — so loaders treat it as empty.
      expect(content.split('\n').every(line => line === '' || line.startsWith('#'))).toBe(true);
      expect(content).toContain('Project-scoped Archon config');
      expect(content).toContain('archon.diy/reference/configuration');
    });

    it('creates the .archon directory if missing (idempotent on parent)', () => {
      const target = join(TEST_DIR, 'bootstrap-no-archon-dir');
      mkdirSync(target, { recursive: true });
      // Do NOT pre-create .archon — bootstrap must create it

      const result = bootstrapProjectConfig(target);

      expect(result.state).toBe('created');
      expect(existsSync(join(target, '.archon'))).toBe(true);
    });

    it('is idempotent — leaves an existing config untouched', () => {
      const target = join(TEST_DIR, 'bootstrap-existing');
      const archonDir = join(target, '.archon');
      mkdirSync(archonDir, { recursive: true });
      const userContent = '# my custom config\nassistants:\n  claude:\n    model: opus\n';
      writeFileSync(join(archonDir, 'config.yaml'), userContent);

      const result = bootstrapProjectConfig(target);

      expect(result.state).toBe('existed');
      const after = readFileSync(join(archonDir, 'config.yaml'), 'utf-8');
      expect(after).toBe(userContent);
    });

    it('returns failed state without throwing when the target path is unwritable', () => {
      // Pointing at a path inside a non-existent parent that mkdirSync can
      // create succeeds. Use a deeply-nested path inside a regular file
      // (which fs cannot mkdir into) to force a real failure.
      const blocker = join(TEST_DIR, 'blocker-file');
      writeFileSync(blocker, 'not a directory');
      // mkdir under a file path fails with ENOTDIR — that's the failure mode
      // we want to model (read-only FS, permission denied, etc.).
      const result = bootstrapProjectConfig(blocker);

      expect(result.state).toBe('failed');
      if (result.state === 'failed') {
        expect(result.error.length).toBeGreaterThan(0);
      }
    });
  });
});
describe('setup provider selection', () => {
  it.each(['fresh', 'add'] as const)(
    '%s setup uses diagnostics and persists the selected default for multiple providers',
    async mode => {
      const root = mkdtempSync(join(tmpdir(), 'archon-setup-providers-'));
      const savedEnv = { ...process.env };
      delete process.env.DEFAULT_AI_ASSISTANT;
      process.env.HOME = root;
      process.env.USERPROFILE = root;
      process.env.ARCHON_HOME = join(root, 'archon');
      if (mode === 'add') {
        mkdirSync(join(root, 'archon'));
        writeFileSync(join(root, 'archon', '.env'), 'SLACK_BOT_TOKEN=preserved\n');
      }
      const selection = spyOn(prompts, 'select').mockImplementation(async options => {
        const wanted =
          options.message === 'What would you like to do?'
            ? 'add'
            : options.message.startsWith('How do you want')
              ? 'global'
              : options.message.startsWith('Which should')
                ? 'codex'
                : '__keep__';
        const chosen = options.options.find(option => option.value === wanted);
        if (!chosen) throw new Error(`Unexpected prompt: ${options.message}`);
        return chosen.value;
      });
      const input = spyOn(prompts, 'text').mockResolvedValue('');
      const confirm = spyOn(prompts, 'confirm').mockImplementation(
        async options => options.message === 'Run `archon doctor` now to verify your setup?'
      );
      const detect = spyOn(providerAuth, 'detectClaudeExecutablePath').mockReturnValue(null);
      const info = spyOn(prompts.log, 'info').mockImplementation(() => undefined);
      const install = mock(async (_ids: readonly string[]) => undefined);
      const diagnose = mock(async (id: string) => [
        { label: id, status: 'pass' as const, message: 'provider-owned check' },
      ]);
      const originalCollect = collectAIConfig;
      const collect = spyOn(setupAi, 'collectAIConfig').mockImplementation(options =>
        originalCollect(options, install, diagnose)
      );
      const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
      const doctor = spyOn(doctorModule, 'doctorCommand').mockResolvedValue(0);
      try {
        expect(await setupCommand({ repoPath: root, providers: ['claude', 'codex'] })).toBe(0);
        expect(detect).toHaveBeenCalled();
        expect(doctor).toHaveBeenCalledWith();
        expect(process.env).toMatchObject({ DEFAULT_AI_ASSISTANT: 'codex' });
        expect(install).toHaveBeenCalledWith(['claude', 'codex']);
        expect(diagnose.mock.calls).toEqual([['claude'], ['codex']]);
        expect(info.mock.calls.flat().join('')).toContain('provider-owned check');
        const written = Bun.YAML.parse(readFileSync(join(root, 'archon', 'config.yaml'), 'utf8'));
        expect(written).toMatchObject({ defaultAssistant: 'codex' });
        if (mode === 'add') {
          expect(readFileSync(join(root, 'archon', '.env'), 'utf8')).toContain(
            'SLACK_BOT_TOKEN=preserved'
          );
        }
      } finally {
        for (const spy of [selection, input, confirm, detect, info, collect, platforms, doctor])
          spy.mockRestore();
        // Restore in place: replacing process.env leaves Bun's native env holding the
        // temp root, which os.homedir() still reads through USERPROFILE on Windows.
        for (const key of Object.keys(process.env)) {
          if (!(key in savedEnv)) delete process.env[key];
        }
        Object.assign(process.env, savedEnv);
        await removeTempTree(root);
      }
    }
  );
});

describe('setup docs path target', () => {
  it('writes the docs path into the project the skill was installed in', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archon-setup-docs-'));
    const repo = join(root, 'repo');
    const target = join(root, 'target');
    mkdirSync(join(repo, '.archon'), { recursive: true });
    mkdirSync(target);
    const repoConfig = '# untouched\n';
    writeFileSync(join(repo, '.archon', 'config.yaml'), repoConfig);
    const savedEnv = { ...process.env };
    delete process.env.DEFAULT_AI_ASSISTANT;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.env.ARCHON_HOME = join(root, 'archon');
    const selection = spyOn(prompts, 'select').mockImplementation(async options => {
      const chosen =
        options.options.find(option => option.value === 'global') ?? options.options[0];
      if (!chosen) throw new Error(`Unexpected prompt: ${options.message}`);
      return chosen.value;
    });
    const input = spyOn(prompts, 'text').mockImplementation(async options =>
      options.message === 'Project path to install the skill:'
        ? target
        : options.message.startsWith('Where are your project docs?')
          ? 'documentation/'
          : ''
    );
    const confirm = spyOn(prompts, 'confirm').mockImplementation(
      async options => !options.message.startsWith('Run `archon doctor`')
    );
    const detect = spyOn(providerAuth, 'detectClaudeExecutablePath').mockReturnValue(null);
    const info = spyOn(prompts.log, 'info').mockImplementation(() => undefined);
    const originalCollect = collectAIConfig;
    const collect = spyOn(setupAi, 'collectAIConfig').mockImplementation(options =>
      originalCollect(
        options,
        async () => undefined,
        async () => []
      )
    );
    const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
    try {
      expect(await setupCommand({ repoPath: repo, providers: ['claude'] })).toBe(0);
      const written = readFileSync(join(target, '.archon', 'config.yaml'), 'utf8');
      expect(Bun.YAML.parse(written)).toEqual({ docs: { path: 'documentation/' } });
      expect(readFileSync(join(repo, '.archon', 'config.yaml'), 'utf8')).toBe(repoConfig);
    } finally {
      for (const spy of [selection, input, confirm, detect, info, collect, platforms])
        spy.mockRestore();
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
      await removeTempTree(root);
    }
  });
});

describe('setup with a Pi login over a saved key', () => {
  it('removes the saved backend key only after the user agrees, keeping other values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archon-setup-pi-login-'));
    const home = join(root, 'home');
    const savedHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = home;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, '.env'), 'XAI_API_KEY=old-key\nCUSTOM_SETTING=keep\n');
    const policies = spyOn(platformRegistry, 'getRegisteredPlatformPolicies').mockReturnValue([]);
    const collect = spyOn(setupAi, 'collectAIConfig').mockResolvedValue({
      claude: false,
      codex: false,
      pi: true,
      piModel: 'xai/grok-4.7',
      piApiKeyEnvVar: 'XAI_API_KEY',
      piLogin: true,
      defaultAssistant: 'pi',
    });
    // Setup-mode question first (an env file exists), then the saved-key question.
    // clack's select is generic over its option values, so the stub needs the cast.
    const select = spyOn(prompts, 'select').mockImplementation((async (options: {
      message: string;
    }) => (options.message.includes('XAI_API_KEY') ? 'remove' : 'add')) as typeof prompts.select);
    const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
    const confirm = spyOn(prompts, 'confirm').mockResolvedValue(false);
    const note = spyOn(prompts, 'note').mockImplementation(() => undefined);
    try {
      expect(await setupCommand({ repoPath: root, inheritedEnv: {} })).toBe(0);
      const env = readFileSync(join(home, '.env'), 'utf8');
      expect(parseDotenv(env).XAI_API_KEY).toBeUndefined();
      expect(parseDotenv(env).CUSTOM_SETTING).toBe('keep');
      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('XAI_API_KEY is set in') })
      );
      const config = Bun.YAML.parse(readFileSync(join(home, 'config.yaml'), 'utf8'));
      expect(config).toMatchObject({ assistants: { pi: { model: 'xai/grok-4.7' } } });
    } finally {
      for (const spy of [collect, select, platforms, confirm, note, policies]) spy.mockRestore();
      if (savedHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = savedHome;
      await removeTempTree(root);
    }
  });
});

describe('setup from the real Pi questions', () => {
  const cancelled = Symbol('cancelled');

  /**
   * Runs setup with the real collectAIConfig and collectPiConfig for Pi, picking xAI and
   * Pi's login. `modelAnswer` answers the saved-model question; every saved-key question
   * is answered with remove. Returns the exit code and every select message shown.
   */
  async function runPiLoginSetup(
    home: string,
    repo: string,
    modelAnswer?: 'keep' | 'switch' | typeof cancelled
  ): Promise<{ code: number; messages: string[]; platforms: ReturnType<typeof spyOn> }> {
    const messages: string[] = [];
    const answers: [(message: string) => boolean, unknown][] = [
      [m => m === 'What would you like to do?', 'add'],
      [m => m === 'Which Pi backend will you use as the default?', 'xai'],
      [m => m.includes('already sets the Pi model'), modelAnswer],
      [m => m.startsWith('How do you want Pi to authenticate'), 'piLogin'],
      [m => m.includes('is set in'), 'remove'],
    ];
    const select = spyOn(prompts, 'select').mockImplementation((async (options: {
      message: string;
    }) => {
      messages.push(options.message);
      const match = answers.find(([matches]) => matches(options.message));
      if (!match || match[1] === undefined)
        throw new Error(`Unexpected prompt: ${options.message}`);
      return match[1];
    }) as typeof prompts.select);
    const isCancel = spyOn(prompts, 'isCancel').mockImplementation(value => value === cancelled);
    const originalCollect = collectAIConfig;
    const collect = spyOn(setupAi, 'collectAIConfig').mockImplementation(options =>
      originalCollect(
        options,
        async () => undefined,
        async () => []
      )
    );
    const policies = spyOn(platformRegistry, 'getRegisteredPlatformPolicies').mockReturnValue([]);
    const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
    const confirm = spyOn(prompts, 'confirm').mockResolvedValue(false);
    const note = spyOn(prompts, 'note').mockImplementation(() => undefined);
    const cancel = spyOn(prompts, 'cancel').mockImplementation(() => undefined);
    const savedHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = home;
    try {
      const code = await setupCommand({ repoPath: repo, providers: ['pi'], inheritedEnv: {} });
      return { code, messages, platforms };
    } finally {
      for (const spy of [select, isCancel, collect, policies, platforms, confirm, note, cancel])
        spy.mockRestore();
      if (savedHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = savedHome;
    }
  }

  let root: string;
  let home: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'archon-setup-pi-flow-'));
    home = join(root, 'home');
    mkdirSync(home, { recursive: true });
  });
  afterEach(async () => {
    await removeTempTree(root);
  });

  it("warns about a saved key after Pi's login is chosen and removes it on agreement", async () => {
    writeFileSync(join(home, '.env'), 'XAI_API_KEY=old-key\nCUSTOM_SETTING=keep\n');

    const { code, messages } = await runPiLoginSetup(home, root);

    expect(code).toBe(0);
    expect(messages).toContain(
      `XAI_API_KEY is set in ${join(home, '.env')}, and Archon uses it instead of Pi's login. What should setup do?`
    );
    const env = parseDotenv(readFileSync(join(home, '.env'), 'utf8'));
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.CUSTOM_SETTING).toBe('keep');
  });

  it('checks the key of a kept model for another backend', async () => {
    writeFileSync(join(home, 'config.yaml'), 'assistants:\n  pi:\n    model: openai/gpt-4o\n');
    writeFileSync(join(home, '.env'), 'OPENAI_API_KEY=old-key\nXAI_API_KEY=xai-key\n');

    const { code, messages } = await runPiLoginSetup(home, root, 'keep');

    expect(code).toBe(0);
    expect(messages).toContain('How do you want Pi to authenticate with OpenAI?');
    expect(messages.some(m => m.startsWith('OPENAI_API_KEY is set in'))).toBe(true);
    expect(messages.some(m => m.startsWith('XAI_API_KEY is set in'))).toBe(false);
    const env = parseDotenv(readFileSync(join(home, '.env'), 'utf8'));
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.XAI_API_KEY).toBe('xai-key');
    const config = Bun.YAML.parse(readFileSync(join(home, 'config.yaml'), 'utf8'));
    expect(config).toMatchObject({ assistants: { pi: { model: 'openai/gpt-4o' } } });
  });

  it('stops before writing anything when the model question is cancelled', async () => {
    const configYaml = 'assistants:\n  pi:\n    model: openai/gpt-4o\n';
    const envFile = 'XAI_API_KEY=old-key\n';
    writeFileSync(join(home, 'config.yaml'), configYaml);
    writeFileSync(join(home, '.env'), envFile);

    const { code, messages, platforms } = await runPiLoginSetup(home, root, cancelled);

    expect(code).toBe(0);
    expect(messages.some(m => m.startsWith('How do you want Pi to authenticate'))).toBe(false);
    expect(platforms).not.toHaveBeenCalled();
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(configYaml);
    expect(readFileSync(join(home, '.env'), 'utf8')).toBe(envFile);
  });
});

describe('setup with a Pi login over a key it cannot remove', () => {
  it('stops before the platform questions when the user backs out, writing nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archon-setup-pi-shell-key-'));
    const home = join(root, 'home');
    const savedHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = home;
    const policies = spyOn(platformRegistry, 'getRegisteredPlatformPolicies').mockReturnValue([]);
    const collect = spyOn(setupAi, 'collectAIConfig').mockResolvedValue({
      claude: false,
      codex: false,
      pi: true,
      piModel: 'xai/grok-4.7',
      piApiKeyEnvVar: 'XAI_API_KEY',
      piLogin: true,
      defaultAssistant: 'pi',
    });
    const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
    const confirm = spyOn(prompts, 'confirm').mockResolvedValue(false);
    const note = spyOn(prompts, 'note').mockImplementation(() => undefined);
    try {
      expect(
        await setupCommand({ repoPath: root, inheritedEnv: { XAI_API_KEY: 'shell-key' } })
      ).toBe(0);
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining('XAI_API_KEY is set in:\n  - your shell environment'),
        "Pi's login will not be used yet"
      );
      expect(platforms).not.toHaveBeenCalled();
      expect(existsSync(join(home, '.env'))).toBe(false);
    } finally {
      for (const spy of [collect, platforms, confirm, note, policies]) spy.mockRestore();
      if (savedHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = savedHome;
      await removeTempTree(root);
    }
  });
});

describe('setup model preferences', () => {
  it('persists the Pi model before writing the default assistant and chat model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archon-setup-models-'));
    const savedHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = join(root, 'home');
    const policies = spyOn(platformRegistry, 'getRegisteredPlatformPolicies').mockReturnValue([]);
    const collect = spyOn(setupAi, 'collectAIConfig').mockResolvedValue({
      claude: true,
      claudeAuthType: 'global',
      codex: false,
      pi: true,
      piModel: 'anthropic/claude-haiku-4-5',
      defaultAssistant: 'claude',
      defaultAssistantSelected: true,
      defaultModel: 'sonnet',
    });
    const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
    const confirm = spyOn(prompts, 'confirm').mockResolvedValue(false);
    const note = spyOn(prompts, 'note').mockImplementation(() => undefined);
    try {
      expect(await setupCommand({ repoPath: root, inheritedEnv: {} })).toBe(0);
      const config = Bun.YAML.parse(readFileSync(join(root, 'home', 'config.yaml'), 'utf8'));
      expect(config).toMatchObject({
        defaultAssistant: 'claude',
        assistants: {
          pi: { model: 'anthropic/claude-haiku-4-5' },
          claude: { model: 'sonnet' },
        },
      });
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining('AI: Claude (global auth), Pi'),
        'Configuration Complete'
      );
    } finally {
      for (const spy of [collect, platforms, confirm, note, policies]) spy.mockRestore();
      if (savedHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = savedHome;
      await removeTempTree(root);
    }
  });
});
