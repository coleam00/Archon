import { describe, expect, it } from 'bun:test';

import { DEFAULT_DISPATCH_SIGIL, resolveDispatch, resolveDispatchSigil } from './dispatch';

const DISPATCH = { 'githubName/githubRepo': 'assignedWorkflow' };

describe('resolveDispatch', () => {
  describe('when the project is listed in dispatch:', () => {
    it('routes a plain message to the configured workflow', () => {
      expect(resolveDispatch('log this note', 'githubName/githubRepo', DISPATCH)).toEqual({
        kind: 'workflow',
        workflowName: 'assignedWorkflow',
        message: 'log this note',
      });
    });

    it('passes the message through verbatim, without trimming', () => {
      // The workflow receives $ARGUMENTS exactly as the user typed it.
      expect(resolveDispatch('  padded  ', 'githubName/githubRepo', DISPATCH)).toEqual({
        kind: 'workflow',
        workflowName: 'assignedWorkflow',
        message: '  padded  ',
      });
    });

    it('leaves slash commands alone', () => {
      expect(resolveDispatch('/status', 'githubName/githubRepo', DISPATCH)).toEqual({
        kind: 'chat',
        message: '/status',
      });
    });

    it('leaves a slash command alone even with leading whitespace', () => {
      expect(resolveDispatch('  /workflow list', 'githubName/githubRepo', DISPATCH)).toEqual({
        kind: 'chat',
        message: '  /workflow list',
      });
    });

    it('falls through to chat on the sigil, stripping it', () => {
      expect(resolveDispatch('? what did I log today', 'githubName/githubRepo', DISPATCH)).toEqual({
        kind: 'chat',
        message: 'what did I log today',
      });
    });

    it('strips whitespace between the sigil and the question', () => {
      expect(resolveDispatch('?   spaced out', 'githubName/githubRepo', DISPATCH)).toEqual({
        kind: 'chat',
        message: 'spaced out',
      });
    });

    it('matches the sigil after leading whitespace', () => {
      expect(resolveDispatch('   ? indented', 'githubName/githubRepo', DISPATCH)).toEqual({
        kind: 'chat',
        message: 'indented',
      });
    });

    it('passes a bare sigil through rather than handing the AI an empty prompt', () => {
      expect(resolveDispatch('? ', 'githubName/githubRepo', DISPATCH)).toEqual({
        kind: 'chat',
        message: '? ',
      });
    });

    it('dispatches a message that merely CONTAINS the sigil', () => {
      // Only a LEADING sigil escapes — otherwise "did it work? really" would too.
      expect(resolveDispatch('did it work? really', 'githubName/githubRepo', DISPATCH)).toEqual({
        kind: 'workflow',
        workflowName: 'assignedWorkflow',
        message: 'did it work? really',
      });
    });

    it('matches the project key case-insensitively', () => {
      expect(resolveDispatch('note', 'GithubName/GithubRepo', DISPATCH)).toEqual({
        kind: 'workflow',
        workflowName: 'assignedWorkflow',
        message: 'note',
      });
    });

    it('trims a padded workflow name from hand-written YAML', () => {
      expect(resolveDispatch('note', 'proj', { proj: '  assignedWorkflow  ' })).toEqual({
        kind: 'workflow',
        workflowName: 'assignedWorkflow',
        message: 'note',
      });
    });
  });

  describe('the default sigil requires its trailing separator', () => {
    // The separator is the whole reason the default is `"? "` and not `"?"`: in
    // an intake thread, a message that merely opens with a question mark is far
    // likelier to be content than an instruction to the router.
    it('dispatches a question mark with no space after it', () => {
      expect(resolveDispatch('?urgent note', 'githubName/githubRepo', DISPATCH)).toEqual({
        kind: 'workflow',
        workflowName: 'assignedWorkflow',
        message: '?urgent note',
      });
    });

    it('dispatches a lone question mark', () => {
      expect(resolveDispatch('?', 'githubName/githubRepo', DISPATCH)).toEqual({
        kind: 'workflow',
        workflowName: 'assignedWorkflow',
        message: '?',
      });
    });

    it('dispatches a doubled question mark', () => {
      expect(resolveDispatch('?? confusing', 'githubName/githubRepo', DISPATCH)).toEqual({
        kind: 'workflow',
        workflowName: 'assignedWorkflow',
        message: '?? confusing',
      });
    });
  });

  describe('with a configured dispatchSigil', () => {
    it('honors a custom prefix', () => {
      expect(resolveDispatch('>> ask the ai', 'githubName/githubRepo', DISPATCH, '>> ')).toEqual({
        kind: 'chat',
        message: 'ask the ai',
      });
    });

    it('stops honoring the default once a custom prefix is set', () => {
      expect(resolveDispatch('? still a note', 'githubName/githubRepo', DISPATCH, '>> ')).toEqual({
        kind: 'workflow',
        workflowName: 'assignedWorkflow',
        message: '? still a note',
      });
    });

    it('supports a separator-less sigil, restoring the original behavior', () => {
      expect(resolveDispatch('?hello', 'githubName/githubRepo', DISPATCH, '?')).toEqual({
        kind: 'chat',
        message: 'hello',
      });
    });

    it('supports a multi-character sigil', () => {
      expect(resolveDispatch('ai: explain', 'githubName/githubRepo', DISPATCH, 'ai: ')).toEqual({
        kind: 'chat',
        message: 'explain',
      });
    });

    it('is case-sensitive, unlike the project key', () => {
      // The project key is written once in YAML, where a capitalization slip is
      // invisible; the sigil is typed by a human on every message, so matching
      // exactly what was configured is the predictable rule.
      expect(resolveDispatch('AI: explain', 'githubName/githubRepo', DISPATCH, 'ai: ')).toEqual({
        kind: 'workflow',
        workflowName: 'assignedWorkflow',
        message: 'AI: explain',
      });
    });
  });

  describe('when dispatch does not apply', () => {
    it('routes to chat for an unlisted project', () => {
      expect(resolveDispatch('hello', 'some/other-repo', DISPATCH)).toEqual({
        kind: 'chat',
        message: 'hello',
      });
    });

    it('leaves a leading sigil INTACT for an unlisted project', () => {
      // The sigil only means "escape dispatch". Where dispatch does not apply
      // there is nothing to escape, and eating the `? ` would silently change
      // what every existing install sends to the AI.
      expect(resolveDispatch('? hello', 'some/other-repo', DISPATCH)).toEqual({
        kind: 'chat',
        message: '? hello',
      });
    });

    it('leaves a leading sigil INTACT when dispatch is not configured at all', () => {
      expect(resolveDispatch('? hello', 'githubName/githubRepo', undefined)).toEqual({
        kind: 'chat',
        message: '? hello',
      });
    });

    it('routes to chat when no project is bound', () => {
      expect(resolveDispatch('hello', undefined, DISPATCH)).toEqual({
        kind: 'chat',
        message: 'hello',
      });
    });

    it('routes to chat when dispatch is not configured', () => {
      expect(resolveDispatch('hello', 'githubName/githubRepo', undefined)).toEqual({
        kind: 'chat',
        message: 'hello',
      });
    });

    it('routes to chat when the table is empty', () => {
      expect(resolveDispatch('hello', 'githubName/githubRepo', {})).toEqual({
        kind: 'chat',
        message: 'hello',
      });
    });
  });

  describe('defensive handling of unvalidated YAML', () => {
    it('ignores a non-string workflow name', () => {
      const malformed = { 'githubName/githubRepo': 42 } as unknown as Record<string, string>;
      expect(resolveDispatch('hello', 'githubName/githubRepo', malformed)).toEqual({
        kind: 'chat',
        message: 'hello',
      });
    });

    it('ignores a blank workflow name', () => {
      expect(
        resolveDispatch('hello', 'githubName/githubRepo', { 'githubName/githubRepo': '   ' })
      ).toEqual({
        kind: 'chat',
        message: 'hello',
      });
    });

    it('ignores a non-object dispatch value', () => {
      const malformed = 'assignedWorkflow' as unknown as Record<string, string>;
      expect(resolveDispatch('hello', 'githubName/githubRepo', malformed)).toEqual({
        kind: 'chat',
        message: 'hello',
      });
    });

    it('falls back to the default sigil when the configured one is empty', () => {
      // An empty prefix matches EVERY message, which would turn dispatch off for
      // the whole install with no error anywhere. It must never be honored.
      expect(resolveDispatch('a note', 'githubName/githubRepo', DISPATCH, '')).toEqual({
        kind: 'workflow',
        workflowName: 'assignedWorkflow',
        message: 'a note',
      });
      expect(resolveDispatch('? a question', 'githubName/githubRepo', DISPATCH, '')).toEqual({
        kind: 'chat',
        message: 'a question',
      });
    });
  });
});

describe('resolveDispatchSigil', () => {
  it('defaults to a question mark FOLLOWED BY A SPACE', () => {
    expect(DEFAULT_DISPATCH_SIGIL).toBe('? ');
    expect(resolveDispatchSigil(undefined)).toBe('? ');
  });

  it('honors a configured sigil', () => {
    expect(resolveDispatchSigil('>> ')).toBe('>> ');
  });

  it('preserves trailing whitespace, which is significant', () => {
    expect(resolveDispatchSigil('!  ')).toBe('!  ');
  });

  it('rejects an empty or whitespace-only sigil', () => {
    expect(resolveDispatchSigil('')).toBe('? ');
    expect(resolveDispatchSigil('   ')).toBe('? ');
  });

  it('rejects a non-string sigil from unvalidated YAML', () => {
    expect(resolveDispatchSigil(42 as unknown as string)).toBe('? ');
    expect(resolveDispatchSigil(null as unknown as string)).toBe('? ');
  });
});
