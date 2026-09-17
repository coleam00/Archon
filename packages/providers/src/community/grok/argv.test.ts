import { describe, expect, test } from 'bun:test';
import { buildGrokArgv, requireNativeGrokSessionUuid } from './argv';

const SESSION = '11111111-1111-4111-8111-111111111111';

describe('buildGrokArgv', () => {
  test('emits oauth headless flags and never yolo', () => {
    const argv = buildGrokArgv({
      command: '/bin/grok',
      prompt: 'hello --yolo',
      cwd: '/repo',
      model: 'grok-4.6',
    });
    expect(argv[0]).toBe('/bin/grok');
    expect(argv).toContain('--oauth');
    expect(argv).toContain('--no-leader');
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('bypassPermissions');
    expect(argv).not.toContain('dontAsk');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('streaming-json');
    expect(argv).toContain('--model');
    expect(argv).toContain('grok-4.6');
    expect(argv).not.toContain('--yolo');
    expect(argv).not.toContain('--always-approve');
    expect(argv).not.toContain('--worktree');
    const promptJson = argv[argv.indexOf('--prompt-json') + 1];
    expect(JSON.parse(promptJson ?? '')).toEqual([{ type: 'text', text: 'hello --yolo' }]);
  });

  test('adds effort, resume, rules, and json schema before streaming-json', () => {
    const argv = buildGrokArgv({
      command: '/bin/grok',
      prompt: 'go',
      cwd: '/repo',
      model: 'grok-4.6',
      effort: 'high',
      resumeSessionId: SESSION,
      jsonSchema: { type: 'object' },
      systemPrompt: 'keep diffs small',
    });
    expect(argv).toEqual(
      expect.arrayContaining(['--reasoning-effort', 'high', '--resume', SESSION])
    );
    expect(argv[argv.indexOf('--rules') + 1]).toBe('keep diffs small');
    expect(argv[argv.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
    expect(argv.lastIndexOf('--output-format')).toBeGreaterThan(argv.indexOf('--json-schema'));
    expect(argv[argv.lastIndexOf('--output-format') + 1]).toBe('streaming-json');
  });

  test('rejects non-uuid resume', () => {
    expect(() =>
      buildGrokArgv({
        command: '/bin/grok',
        prompt: 'go',
        cwd: '/repo',
        model: 'grok-4.6',
        resumeSessionId: 'latest',
      })
    ).toThrow(/native session UUID/);
  });
});

describe('requireNativeGrokSessionUuid', () => {
  test('accepts a v4 uuid', () => {
    expect(requireNativeGrokSessionUuid(SESSION)).toBe(SESSION);
  });
});
