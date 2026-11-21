import { describe, expect, test } from 'bun:test';
import { patchYamlText } from './config-yaml-patch';

type YamlMap = Record<string, unknown>;

const COMMENTED = `# my archon config
botName: Archon # keep this comment
assistants:
  claude:
    model: sonnet # keep this one too

# trailing note
`;

/** Patch `text` and check it reads back as exactly the settings `change` produced. */
function patch(text: string, change: (settings: YamlMap) => YamlMap): string {
  const current = (Bun.YAML.parse(text) ?? {}) as YamlMap;
  const next = change(structuredClone(current));
  const patched = patchYamlText(text, current, next);
  expect(Bun.YAML.parse(patched) ?? {}).toEqual(JSON.parse(JSON.stringify(next)));
  return patched;
}

function expectComments(text: string): void {
  for (const comment of [
    '# my archon config',
    '# keep this comment',
    '# keep this one too',
    '# trailing note',
  ]) {
    expect(text).toContain(comment);
  }
}

describe('patchYamlText', () => {
  test('a new key keeps every comment and the block layout', () => {
    const patched = patch(COMMENTED, settings => ({ ...settings, defaultAssistant: 'claude' }));
    expectComments(patched);
    expect(patched).toContain('assistants:\n  claude:\n    model: sonnet # keep this one too\n');
    expect(patched).toContain('defaultAssistant: claude\n');
  });

  test('a nested change rewrites only that value', () => {
    const patched = patch(COMMENTED, settings => {
      (settings.assistants as YamlMap).claude = { model: 'opus' };
      (settings.assistants as YamlMap).pi = { model: 'm' };
      return settings;
    });
    expect(patched).toContain('model: opus # keep this one too');
    expect(patched).toContain('# my archon config');
    expect(patched).toContain('botName: Archon # keep this comment');
    expect(patched).toContain('# trailing note');
  });

  test('a removed key goes, the rest keeps its comments', () => {
    const patched = patch(COMMENTED, settings => {
      delete settings.botName;
      return settings;
    });
    expect(patched).not.toContain('botName');
    expect(patched).toContain('# keep this one too');
    expect(patched).toContain('# trailing note');
  });

  test('a nested removal keeps the comments of the entries that stay', () => {
    const text = `aliases:
  "@a": # about a
    provider: claude
    model: opus
  # about b
  "@b":
    provider: codex # b provider
    model: gpt
`;
    const patched = patch(text, settings => {
      delete (settings.aliases as YamlMap)['@a'];
      return settings;
    });
    expect(patched).not.toContain('@a');
    expect(patched).toContain('# about b');
    expect(patched).toContain('provider: codex # b provider');
  });

  test('a changed list is written whole and the keys around it keep their comments', () => {
    const patched = patch('# list\nitems:\n  - a\n  - b\nother: 1 # keep\n', settings => ({
      ...settings,
      items: ['a', 'c'],
    }));
    expect(patched).toContain('# list\n');
    expect(patched).toContain('other: 1 # keep');
  });

  test('an undefined value is removed, not written as null', () => {
    const patched = patchYamlText(COMMENTED, { botName: 'Archon' }, { botName: undefined });
    expect(patched).not.toContain('botName');
    expect(patched).not.toContain('null');
  });

  test('a file that is only comments keeps them', () => {
    const template = '# Archon Global Configuration\n\n# botName: Archon\n';
    const patched = patch(template, settings => ({ ...settings, defaultAssistant: 'claude' }));
    expect(patched).toContain('# Archon Global Configuration');
    expect(patched).toContain('# botName: Archon');
  });

  test('an empty file becomes just the settings', () => {
    expect(patch('', settings => ({ ...settings, defaultAssistant: 'claude' }))).toBe(
      'defaultAssistant: claude\n'
    );
  });

  test('a scalar replaced by a map keeps the rest of the file', () => {
    const patched = patch('assistants: ~\nx: 1 # keep\n', settings => ({
      ...settings,
      assistants: { claude: { model: 'opus' } },
    }));
    expect(patched).toContain('x: 1 # keep');
  });

  test('a value behind an alias is written without touching the anchor', () => {
    const text = 'base: &b { model: sonnet }\nassistants:\n  claude: *b\n';
    const current = Bun.YAML.parse(text) as YamlMap;
    const next = { ...current, assistants: { claude: { model: 'opus' } } };
    const patched = patchYamlText(text, current, next);
    expect(Bun.YAML.parse(patched)).toEqual({
      base: { model: 'sonnet' },
      assistants: { claude: { model: 'opus' } },
    });
  });

  test('strings read back as strings and a long one stays on one line', () => {
    const long = `${'word '.repeat(40)}end`;
    const strings = { a: 'yes', b: '123', c: 'a: b', d: '', e: 'one\ntwo', long };
    const patched = patch(COMMENTED, settings => ({ ...settings, ...strings }));
    expect(patched).toContain(`long: ${long}\n`);
  });

  test('a repeated key is changed where Bun reads it, and removed in full', () => {
    const text = 'botName: First\nbotName: Second\n';
    expect(patch(text, settings => ({ ...settings, botName: 'Third' }))).toBe('botName: Third\n');
    expect(
      patch(text, settings => {
        delete settings.botName;
        return settings;
      })
    ).not.toContain('botName');
  });

  test('a null root takes the new settings and keeps its comments', () => {
    expect(patch('null\n', settings => ({ ...settings, a: 1 }))).toBe('a: 1\n');
    const patched = patch('# header\n~ # note\n', settings => ({ ...settings, a: 1 }));
    expect(patched).toContain('# header');
    expect(patched).toContain('# note');
  });

  describe('a value two keys share through an alias', () => {
    const text = 'tiers:\n  small: &p {provider: claude, model: sonnet}\n  large: *p\n';

    test('changing one leaves the other as it was', () => {
      const patched = patch(text, settings => {
        (settings.tiers as YamlMap).small = { provider: 'claude', model: 'haiku' };
        return settings;
      });
      expect(Bun.YAML.parse(patched)).toMatchObject({
        tiers: { large: { model: 'sonnet' } },
      });
    });

    test('removing the anchored key keeps the other and leaves no dangling alias', () => {
      const patched = patch(text, settings => {
        delete (settings.tiers as YamlMap).small;
        return settings;
      });
      expect(patched).not.toContain('*p');
    });
  });

  test('syntax the YAML parser reports is thrown, not written over', () => {
    expect(() => patchYamlText('a: [1, 2\n', {}, { b: 1 })).toThrow();
  });
});
