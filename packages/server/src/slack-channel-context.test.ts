import { describe, test, expect, mock } from 'bun:test';
import { resolveSlackChannelContext } from './slack-channel-context';
import type { SlackChannelContextDeps } from './slack-channel-context';
import type { SlackChannelNameResult } from '@archon/adapters';

type MockedDeps = {
  resolveChannelName: ReturnType<typeof mock>;
  findCodebaseByName: ReturnType<typeof mock>;
} & SlackChannelContextDeps;

/**
 * Build injected deps. `name` is what conversations.info resolves to; pass a
 * result union directly to exercise the dm / unavailable paths. `projects` is
 * the set of REGISTERED project names (anything else resolves to null).
 */
function makeDeps(
  name: SlackChannelNameResult = { kind: 'name', name: 'ai-web-project' },
  projects: readonly string[] = ['web']
): MockedDeps {
  return {
    resolveChannelName: mock(() => Promise.resolve(name)),
    findCodebaseByName: mock((project: string) =>
      Promise.resolve(projects.includes(project) ? { id: `cb-${project}` } : null)
    ),
  } as MockedDeps;
}

describe('resolveSlackChannelContext', () => {
  describe('defaults (no slack config at all)', () => {
    test('resolves the channel name — awareness works with no config', async () => {
      const deps = makeDeps();
      const result = await resolveSlackChannelContext('C123', undefined, deps);

      expect(result.channelName).toBe('ai-web-project');
      expect(result.codebaseId).toBeUndefined();
      expect(deps.resolveChannelName).toHaveBeenCalledTimes(1);
    });

    test('binds nothing when there is no channelProjects map', async () => {
      const deps = makeDeps();
      const result = await resolveSlackChannelContext('C123', {}, deps);

      expect(result.codebaseId).toBeUndefined();
      expect(deps.findCodebaseByName).not.toHaveBeenCalled();
    });
  });

  describe('name keying (useChannelName default true)', () => {
    test('binds a mapped channel name to its registered project', async () => {
      const deps = makeDeps();
      const result = await resolveSlackChannelContext(
        'C123',
        { channelProjects: { 'ai-web-project': 'web' } },
        deps
      );

      expect(result.codebaseId).toBe('cb-web');
      expect(deps.findCodebaseByName).toHaveBeenCalledWith('web');
    });

    test('matches map keys case-insensitively (config may not be lower-cased)', async () => {
      const deps = makeDeps();
      const result = await resolveSlackChannelContext(
        'C123',
        { channelProjects: { 'AI-Web-Project': 'web' } },
        deps
      );

      expect(result.codebaseId).toBe('cb-web');
    });

    test('leaves an unmapped channel unbound', async () => {
      const deps = makeDeps({ kind: 'name', name: 'some-other-channel' });
      const result = await resolveSlackChannelContext(
        'C123',
        { channelProjects: { 'ai-web-project': 'web' } },
        deps
      );

      expect(result.codebaseId).toBeUndefined();
      expect(deps.findCodebaseByName).not.toHaveBeenCalled();
    });

    test('reports an unregistered project instead of binding (caller logs it)', async () => {
      const deps = makeDeps({ kind: 'name', name: 'ai-web-project' }, []);
      const result = await resolveSlackChannelContext(
        'C123',
        { channelProjects: { 'ai-web-project': 'typo-project' } },
        deps
      );

      expect(result.codebaseId).toBeUndefined();
      expect(result.unresolvedProject).toBe('typo-project');
      // The channel name is still reported — awareness must survive a bad mapping.
      expect(result.channelName).toBe('ai-web-project');
    });

    test('does not bind when the name cannot be resolved (missing scope)', async () => {
      const deps = makeDeps({ kind: 'unavailable' });
      const result = await resolveSlackChannelContext(
        'C123',
        { channelProjects: { 'ai-web-project': 'web' } },
        deps
      );

      expect(result.channelName).toBeUndefined();
      expect(result.codebaseId).toBeUndefined();
      expect(deps.findCodebaseByName).not.toHaveBeenCalled();
    });

    test('does not bind in a DM (no channel name exists to key on)', async () => {
      const deps = makeDeps({ kind: 'dm' });
      const result = await resolveSlackChannelContext(
        'D123',
        { channelProjects: { 'ai-web-project': 'web' } },
        deps
      );

      expect(result.channelName).toBeUndefined();
      expect(result.codebaseId).toBeUndefined();
    });
  });

  describe('ID keying (useChannelName: false)', () => {
    test('binds by channel ID without ever calling the Slack API', async () => {
      const deps = makeDeps();
      const result = await resolveSlackChannelContext(
        'C123',
        { useChannelName: false, channelProjects: { C123: 'web' } },
        deps
      );

      expect(result.codebaseId).toBe('cb-web');
      // The whole point of ID keying: no conversations.info, no extra scopes.
      expect(deps.resolveChannelName).not.toHaveBeenCalled();
      expect(result.channelName).toBeUndefined();
    });

    test('matches channel IDs case-sensitively (Slack IDs are case-sensitive)', async () => {
      const deps = makeDeps();
      const result = await resolveSlackChannelContext(
        'C123',
        { useChannelName: false, channelProjects: { c123: 'web' } },
        deps
      );

      expect(result.codebaseId).toBeUndefined();
    });

    test('ignores name-keyed entries when keying by ID', async () => {
      const deps = makeDeps();
      const result = await resolveSlackChannelContext(
        'C123',
        { useChannelName: false, channelProjects: { 'ai-web-project': 'web' } },
        deps
      );

      expect(result.codebaseId).toBeUndefined();
    });
  });

  describe('autoSetProject: false', () => {
    test('skips binding but still resolves the name (flags are independent)', async () => {
      const deps = makeDeps();
      const result = await resolveSlackChannelContext(
        'C123',
        { autoSetProject: false, channelProjects: { 'ai-web-project': 'web' } },
        deps
      );

      expect(result.codebaseId).toBeUndefined();
      expect(deps.findCodebaseByName).not.toHaveBeenCalled();
      // Channel awareness must keep working with auto-binding turned off.
      expect(result.channelName).toBe('ai-web-project');
    });
  });

  describe('channelNameStatus (why a name is missing)', () => {
    test('is undefined when the name resolved', async () => {
      const result = await resolveSlackChannelContext('C123', {}, makeDeps());

      expect(result.channelName).toBe('ai-web-project');
      expect(result.channelNameStatus).toBeUndefined();
    });

    test("is 'disabled' when useChannelName is off", async () => {
      const result = await resolveSlackChannelContext(
        'C123',
        { useChannelName: false },
        makeDeps()
      );

      expect(result.channelNameStatus).toBe('disabled');
    });

    test("is 'unavailable' when the lookup failed (e.g. missing scope)", async () => {
      const result = await resolveSlackChannelContext(
        'C123',
        {},
        makeDeps({ kind: 'unavailable' })
      );

      expect(result.channelNameStatus).toBe('unavailable');
    });

    test("is 'dm' for a direct message", async () => {
      const result = await resolveSlackChannelContext('D123', {}, makeDeps({ kind: 'dm' }));

      expect(result.channelNameStatus).toBe('dm');
    });

    test('survives autoSetProject: false — awareness is independent of binding', async () => {
      const result = await resolveSlackChannelContext(
        'C123',
        { autoSetProject: false, useChannelName: false },
        makeDeps()
      );

      expect(result.channelNameStatus).toBe('disabled');
      expect(result.codebaseId).toBeUndefined();
    });

    test('survives an unresolved project mapping', async () => {
      const deps = makeDeps({ kind: 'unavailable' }, []);
      const result = await resolveSlackChannelContext(
        'C123',
        { useChannelName: false, channelProjects: { C123: 'typo-project' } },
        deps
      );

      expect(result.unresolvedProject).toBe('typo-project');
      expect(result.channelNameStatus).toBe('disabled');
    });
  });

  describe('malformed config (YAML is cast, never schema-validated)', () => {
    test('ignores a non-string mapping value', async () => {
      const deps = makeDeps();
      const result = await resolveSlackChannelContext(
        'C123',
        { channelProjects: { 'ai-web-project': 42 as unknown as string } },
        deps
      );

      expect(result.codebaseId).toBeUndefined();
      expect(deps.findCodebaseByName).not.toHaveBeenCalled();
    });

    test('ignores a blank mapping value', async () => {
      const deps = makeDeps();
      const result = await resolveSlackChannelContext(
        'C123',
        { channelProjects: { 'ai-web-project': '   ' } },
        deps
      );

      expect(result.codebaseId).toBeUndefined();
    });

    test('trims surrounding whitespace on a mapping value', async () => {
      const deps = makeDeps();
      const result = await resolveSlackChannelContext(
        'C123',
        { channelProjects: { 'ai-web-project': '  web  ' } },
        deps
      );

      expect(result.codebaseId).toBe('cb-web');
      expect(deps.findCodebaseByName).toHaveBeenCalledWith('web');
    });
  });
});
