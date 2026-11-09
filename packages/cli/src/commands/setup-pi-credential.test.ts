import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as prompts from '@clack/prompts';
import { removeTempTree } from '@archon/paths/test-utils';
import { reconcilePiCredential, type PiCredentialTarget } from './setup-pi-credential';
import { SetupExit, type SetupConfig } from './setup-shared';

describe('reconcilePiCredential', () => {
  let root: string;
  let home: string;
  let repo: string;
  let originalHome: string | undefined;
  const spies: { mockRestore(): void }[] = [];
  let select: ReturnType<typeof spyOn>;
  let confirm: ReturnType<typeof spyOn>;
  let note: ReturnType<typeof spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'archon-setup-pi-credential-'));
    home = join(root, 'home');
    repo = join(root, 'repo');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(repo, '.archon'), { recursive: true });
    originalHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = home;
    // Any prompt a test does not answer rejects, so an unexpected question fails the test.
    select = spyOn(prompts, 'select').mockRejectedValue(new Error('unexpected select'));
    confirm = spyOn(prompts, 'confirm').mockRejectedValue(new Error('unexpected confirm'));
    note = spyOn(prompts, 'note').mockImplementation(() => undefined);
    spies.push(select, confirm, note);
  });

  afterEach(async () => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    if (originalHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalHome;
    await removeTempTree(root);
  });

  const target = (force = false): PiCredentialTarget => ({
    scope: 'home',
    force,
    repoPath: repo,
    targetEnvPath: join(home, '.env'),
  });
  const login = (): SetupConfig['ai'] => ({
    claude: false,
    codex: false,
    pi: true,
    piModel: 'xai/grok-4.7',
    piApiKeyEnvVar: 'XAI_API_KEY',
    piLogin: true,
    defaultAssistant: 'pi',
  });
  const pasted = (key: string): SetupConfig['ai'] => ({
    ...login(),
    piLogin: false,
    piApiKey: key,
  });
  it('asks nothing when no key is set anywhere', async () => {
    expect(await reconcilePiCredential(login(), target(), {})).toEqual([]);
  });

  it('removes the saved key from the target file when the user picks remove', async () => {
    writeFileSync(join(home, '.env'), 'XAI_API_KEY=old\n');
    select.mockResolvedValueOnce('remove');
    expect(await reconcilePiCredential(login(), target(), {})).toEqual(['XAI_API_KEY']);
    const removeOption = (
      select.mock.calls[0]?.[0] as { options: { value: string; hint?: string }[] }
    ).options.find(option => option.value === 'remove');
    expect(removeOption?.hint).toContain('loses it too');
  });

  it('keeps the saved key and asks nothing more when the user picks useKey', async () => {
    writeFileSync(join(home, '.env'), 'XAI_API_KEY=old\n');
    select.mockResolvedValueOnce('useKey');
    // Shell key too: once the user keeps a key, there is no login left to warn about.
    expect(await reconcilePiCredential(login(), target(), { XAI_API_KEY: 'shell' })).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('still asks about keys elsewhere after removing the saved one', async () => {
    writeFileSync(join(home, '.env'), 'XAI_API_KEY=old\n');
    select.mockResolvedValueOnce('remove');
    confirm.mockResolvedValueOnce(true);
    expect(await reconcilePiCredential(login(), target(), { XAI_API_KEY: 'shell' })).toEqual([
      'XAI_API_KEY',
    ]);
    expect(note.mock.calls[0]?.[0]).toContain('your shell environment');
  });

  it('exits without changes when the user cancels on a saved key', async () => {
    writeFileSync(join(home, '.env'), 'XAI_API_KEY=old\n');
    select.mockResolvedValueOnce('cancel');
    await expect(reconcilePiCredential(login(), target(), {})).rejects.toEqual(new SetupExit(0));
  });

  it('ignores the saved key under --force, which rewrites the file', async () => {
    writeFileSync(join(home, '.env'), 'XAI_API_KEY=old\n');
    expect(await reconcilePiCredential(login(), target(true), {})).toEqual([]);
  });

  it('names every place outside the target file that still sets the key', async () => {
    writeFileSync(join(repo, '.archon', '.env'), 'XAI_API_KEY=project\n');
    writeFileSync(
      join(home, 'config.yaml'),
      'assistants:\n  pi:\n    env:\n      XAI_API_KEY: cfg\n'
    );
    writeFileSync(
      join(repo, '.archon', 'config.yaml'),
      'env:\n  XAI_API_KEY: repo\nassistants:\n  pi:\n    env:\n      XAI_API_KEY: repo-pi\n'
    );
    confirm.mockResolvedValueOnce(true);
    expect(await reconcilePiCredential(login(), target(), { XAI_API_KEY: 'shell' })).toEqual([]);
    const shown = note.mock.calls[0]?.[0];
    expect(shown).toContain('your shell environment');
    expect(shown).toContain(join(repo, '.archon', '.env'));
    expect(shown).toContain(`assistants.pi.env in ${join(home, 'config.yaml')}`);
    expect(shown).toContain(`assistants.pi.env in ${join(repo, '.archon', 'config.yaml')}`);
    expect(shown).toContain(`env in ${join(repo, '.archon', 'config.yaml')}`);
  });

  it('exits without changes when the user stops over a key setup cannot remove', async () => {
    confirm.mockResolvedValueOnce(false);
    await expect(
      reconcilePiCredential(login(), target(), { XAI_API_KEY: 'shell' })
    ).rejects.toEqual(new SetupExit(0));
  });

  it('warns when it cannot parse a config.yaml it has to check', async () => {
    const warning = spyOn(prompts.log, 'warning').mockImplementation(() => undefined);
    spies.push(warning);
    writeFileSync(join(repo, '.archon', 'config.yaml'), 'env: [unclosed\n');
    expect(await reconcilePiCredential(login(), target(), {})).toEqual([]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(`Could not parse ${join(repo, '.archon', 'config.yaml')}`)
    );
  });

  it('does not count an empty value as a key', async () => {
    writeFileSync(join(home, '.env'), 'XAI_API_KEY=\n');
    expect(await reconcilePiCredential(login(), target(), { XAI_API_KEY: '  ' })).toEqual([]);
  });

  it('replaces a different saved key with the pasted one when the user agrees', async () => {
    writeFileSync(join(home, '.env'), 'XAI_API_KEY=old\n');
    confirm.mockResolvedValueOnce(true);
    expect(await reconcilePiCredential(pasted('new'), target(), {})).toEqual(['XAI_API_KEY']);
  });

  it('keeps the saved key when the user declines to replace it', async () => {
    writeFileSync(join(home, '.env'), 'XAI_API_KEY=old\n');
    confirm.mockResolvedValueOnce(false);
    expect(await reconcilePiCredential(pasted('new'), target(), {})).toEqual([]);
  });

  it('does not ask when the pasted key matches the saved one', async () => {
    writeFileSync(join(home, '.env'), 'XAI_API_KEY=same\n');
    expect(await reconcilePiCredential(pasted('same'), target(), {})).toEqual([]);
  });
});
