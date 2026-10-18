/**
 * Tests for the AI step of `archon setup`
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as prompts from '@clack/prompts';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  buildDefaultModelChoices,
  readInstallDefaultModel,
  selectSetupProviders,
  writeInstallDefaults,
} from './setup-ai';

describe('buildDefaultModelChoices (#1999)', () => {
  it('leads with "Keep SDK default" when no current model and ends with the free-text escape', () => {
    const choices = buildDefaultModelChoices('claude', undefined);
    expect(choices[0].value).toBe('__keep__');
    expect(choices[0].label).toBe('Keep SDK default');
    expect(choices[choices.length - 1].value).toBe('__custom__');
  });

  it('surfaces the current model in the keep option label on re-run', () => {
    const choices = buildDefaultModelChoices('claude', 'opus');
    expect(choices[0].label).toBe('Keep current (opus)');
  });

  it('includes the curated claude shortlist between keep and custom', () => {
    const values = buildDefaultModelChoices('claude', undefined).map(c => c.value);
    expect(values).toEqual(['__keep__', 'sonnet', 'opus', 'haiku', '__custom__']);
  });

  it('includes the curated codex shortlist', () => {
    const values = buildDefaultModelChoices('codex', undefined).map(c => c.value);
    expect(values).toEqual([
      '__keep__',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      '__custom__',
    ]);
  });

  it('falls back to keep + custom only for providers without a curated list', () => {
    const values = buildDefaultModelChoices('some-future-provider', undefined).map(c => c.value);
    expect(values).toEqual(['__keep__', '__custom__']);
  });
});

describe('writeInstallDefaults (#1999)', () => {
  const baseAi = {
    claude: true,
    codex: false,
    pi: false,
    defaultAssistant: 'claude',
  };

  it('writes provider + model together when a chat model was chosen', async () => {
    const calls: [string, string | undefined][] = [];
    const written = await writeInstallDefaults(
      { ...baseAi, defaultAssistantSelected: true, defaultModel: 'opus' },
      async (provider, model) => {
        calls.push([provider, model]);
      }
    );
    expect(written).toBe(true);
    expect(calls).toEqual([['claude', 'opus']]);
  });

  it('writes defaultAssistant alone when the model was skipped (stale-config guard)', async () => {
    // The .env DEFAULT_AI_ASSISTANT is fallback-only, so skipping the model
    // must still record the wizard's fresh selection in config.yaml.
    const calls: [string, string | undefined][] = [];
    const written = await writeInstallDefaults(
      { ...baseAi, defaultAssistantSelected: true },
      async (provider, model) => {
        calls.push([provider, model]);
      }
    );
    expect(written).toBe(true);
    expect(calls).toEqual([['claude', undefined]]);
  });

  it('does not write when the default was a registry fallback, not a selection', async () => {
    // 'add' mode and the no-assistant early return leave
    // defaultAssistantSelected unset — the fallback value must never clobber
    // an existing config.yaml defaultAssistant.
    const calls: unknown[] = [];
    const written = await writeInstallDefaults({ ...baseAi }, async (...args) => {
      calls.push(args);
    });
    expect(written).toBe(false);
    expect(calls).toEqual([]);
  });

  it('is non-fatal when the write fails (env write already succeeded)', async () => {
    const written = await writeInstallDefaults(
      { ...baseAi, defaultAssistantSelected: true, defaultModel: 'opus' },
      async () => {
        throw Object.assign(new Error('read-only fs'), { code: 'EROFS' });
      }
    );
    expect(written).toBe(false);
  });
});

describe('readInstallDefaultModel (#1999)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archon-default-model-'));
  });

  afterEach(async () => {
    await removeTempTree(tmpDir);
  });

  const configAt = (content: string): string => {
    const path = join(tmpDir, 'config.yaml');
    writeFileSync(path, content);
    return path;
  };

  it('returns the configured model from assistants.<provider>.model', () => {
    const path = configAt(
      'assistants:\n  claude:\n    model: opus\n  codex:\n    model: gpt-5.5\n'
    );
    expect(readInstallDefaultModel('claude', path)).toBe('opus');
    expect(readInstallDefaultModel('codex', path)).toBe('gpt-5.5');
  });

  it('returns undefined when the config file does not exist', () => {
    expect(readInstallDefaultModel('claude', join(tmpDir, 'missing.yaml'))).toBeUndefined();
  });

  it('returns undefined when the provider has no model entry', () => {
    const path = configAt('assistants:\n  claude:\n    settingSources:\n      - project\n');
    expect(readInstallDefaultModel('claude', path)).toBeUndefined();
    expect(readInstallDefaultModel('codex', path)).toBeUndefined();
  });

  it('treats inherit / empty / non-string models as unset', () => {
    expect(
      readInstallDefaultModel('claude', configAt('assistants:\n  claude:\n    model: inherit\n'))
    ).toBeUndefined();
    expect(
      readInstallDefaultModel('claude', configAt('assistants:\n  claude:\n    model: ""\n'))
    ).toBeUndefined();
    expect(
      readInstallDefaultModel('claude', configAt('assistants:\n  claude:\n    model: 42\n'))
    ).toBeUndefined();
  });

  it('returns undefined (not a throw) on malformed YAML', () => {
    // Best-effort hint read: a hand-edited broken config must not break setup.
    expect(readInstallDefaultModel('claude', configAt(':: not yaml ::\n\t{ nope'))).toBeUndefined();
  });
});

describe('setup provider selection', () => {
  it('an explicit selection installs without asking', async () => {
    const install = mock(async (_ids: readonly string[]) => undefined);
    const ask = mock(async () => ['claude']);
    expect(await selectSetupProviders(['codex'], install, ask)).toEqual(['codex']);
    expect(install).toHaveBeenCalledWith(['codex']);
    expect(ask).not.toHaveBeenCalled();
  });

  it('the maintained-provider multiselect drives installation', async () => {
    const prompt = spyOn(prompts, 'multiselect').mockResolvedValue(['codex', 'pi']);
    const install = mock(async (_ids: readonly string[]) => undefined);
    try {
      expect(await selectSetupProviders(undefined, install)).toEqual(['codex', 'pi']);
      expect(install).toHaveBeenCalledWith(['codex', 'pi']);
      expect(prompt.mock.calls[0][0].options.map(option => option.value)).toEqual([
        'claude',
        'codex',
        'pi',
      ]);
    } finally {
      prompt.mockRestore();
    }
  });

  it('an empty selection installs nothing and prints the install command', async () => {
    const install = mock(async (_ids: readonly string[]) => undefined);
    const warning = spyOn(prompts.log, 'warning').mockImplementation(() => undefined);
    try {
      expect(await selectSetupProviders([], install)).toEqual([]);
      expect(install).not.toHaveBeenCalled();
      expect(warning.mock.calls.flat().join('')).toContain('archon provider add');
    } finally {
      warning.mockRestore();
    }
  });

  it('validates the whole selection before installing and propagates install failure', async () => {
    const install = mock(async (_ids: readonly string[]) => {
      throw new Error('download failed');
    });
    await expect(selectSetupProviders(['codex', 'unknown'], install)).rejects.toThrow(
      'Unknown maintained provider'
    );
    expect(install).not.toHaveBeenCalled();
    await expect(selectSetupProviders(['codex'], install)).rejects.toThrow('download failed');
  });
});
