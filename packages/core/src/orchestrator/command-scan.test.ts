// @archon-test-isolated
import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { makeTestWorkflow } from '@archon/workflows/test-utils';
import { createMockLogger } from '../test/mocks/logger';
import type { Codebase } from '../types';

const mockLogger = createMockLogger();
mock.module('./agent-log', () => ({ getLog: () => mockLogger }));

import { parseOrchestratorCommands } from './command-scan';

function makeNamedCodebase(name: string): Codebase {
  return {
    id: `id-${name}`,
    name,
    repository_url: null,
    default_cwd: `/repos/${name}`,
    default_branch: null,
    ai_assistant_type: 'claude',
    kind: 'repo',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
  };
}

// ─── parseOrchestratorCommands ────────────────────────────────────────────────

describe('parseOrchestratorCommands', () => {
  const assistWorkflow = makeTestWorkflow({ name: 'assist' });
  const implementWorkflow = makeTestWorkflow({ name: 'implement' });
  const planWorkflow = makeTestWorkflow({ name: 'plan' });

  const myProject = makeNamedCodebase('my-project');
  const orgProject = makeNamedCodebase('coleam00/Archon');

  const workflows = [assistWorkflow, implementWorkflow, planWorkflow];
  const codebases = [myProject, orgProject];

  beforeEach(() => {
    mockLogger.warn.mockClear();
  });

  // ─── Basic /invoke-workflow parsing ─────────────────────────────────────────

  describe('/invoke-workflow basic parsing', () => {
    test('parses a simple /invoke-workflow command', () => {
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).not.toBeNull();
      expect(result.workflowInvocation?.workflowName).toBe('assist');
      expect(result.workflowInvocation?.projectName).toBe('my-project');
    });

    test('parses /invoke-workflow at the start of a multiline response', () => {
      const response =
        'Let me help you with that.\n/invoke-workflow implement --project my-project\nSome trailing text.';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).not.toBeNull();
      expect(result.workflowInvocation?.workflowName).toBe('implement');
    });

    test('returns remaining text before the command as remainingMessage', () => {
      const response = 'I will run the workflow now.\n/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.remainingMessage).toBe('I will run the workflow now.');
    });

    test('remainingMessage is empty string when command is at the start', () => {
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.remainingMessage).toBe('');
    });

    test('parses --project with equals sign separator', () => {
      const response = '/invoke-workflow assist --project=my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).not.toBeNull();
      expect(result.workflowInvocation?.projectName).toBe('my-project');
    });

    test('does not capture trailing text after project name (uses \\S+ for project)', () => {
      // The regex uses (\S+) for project name so trailing text is excluded
      const response = '/invoke-workflow assist --project my-project some extra stuff here';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // Should still match since "my-project" is parsed as non-whitespace token
      expect(result.workflowInvocation).not.toBeNull();
      expect(result.workflowInvocation?.projectName).toBe('my-project');
    });

    test('strips markdown bold from /invoke-workflow and parses correctly', () => {
      const response = '**/invoke-workflow assist --project my-project**';
      const result = parseOrchestratorCommands(response, codebases, workflows);
      expect(result.workflowInvocation?.workflowName).toBe('assist');
      expect(result.workflowInvocation?.projectName).toBe('my-project');
    });
  });

  // ─── --prompt parameter ──────────────────────────────────────────────────────

  describe('--prompt parameter', () => {
    test('parses --prompt with double quotes', () => {
      const response =
        '/invoke-workflow implement --project my-project --prompt "Add dark mode support"';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.synthesizedPrompt).toBe('Add dark mode support');
    });

    test('parses --prompt with single quotes', () => {
      const response =
        "/invoke-workflow implement --project my-project --prompt 'Add dark mode support'";
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.synthesizedPrompt).toBe('Add dark mode support');
    });

    test('synthesizedPrompt is undefined when --prompt is absent', () => {
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.synthesizedPrompt).toBeUndefined();
    });

    test('parses --prompt with --project= equals syntax', () => {
      const response =
        '/invoke-workflow implement --project=my-project --prompt "Summarize the README"';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.projectName).toBe('my-project');
      expect(result.workflowInvocation?.synthesizedPrompt).toBe('Summarize the README');
    });

    test('keeps escaped quotes inside a double-quoted --prompt', () => {
      const response =
        '/invoke-workflow implement --project my-project --prompt "Fix the \\"login\\" bug and add tests"';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.synthesizedPrompt).toBe(
        'Fix the "login" bug and add tests'
      );
    });

    test('keeps escaped quotes inside a single-quoted --prompt', () => {
      const response =
        "/invoke-workflow implement --project my-project --prompt 'Don\\'t break the build'";
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.synthesizedPrompt).toBe("Don't break the build");
    });

    test('leaves backslashes that do not escape a quote untouched', () => {
      const response =
        '/invoke-workflow implement --project my-project --prompt "Edit C:\\Users\\me\\file"';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.synthesizedPrompt).toBe('Edit C:\\Users\\me\\file');
    });

    test('synthesizedPrompt is undefined when --prompt has empty string (double quotes)', () => {
      // The quoted-argument pattern requires at least one character, so "" does not match.
      // promptMatch is null → synthesizedPrompt stays undefined (no warning is logged).
      const response = '/invoke-workflow assist --project my-project --prompt ""';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.synthesizedPrompt).toBeUndefined();
    });

    test('does not log synthesized_prompt_empty_discarded warning when --prompt ""', () => {
      // With --prompt "", the quoted-argument pattern does not match so promptMatch is null.
      // The `if (promptMatch && !synthesizedPrompt)` guard is never entered.
      const response = '/invoke-workflow assist --project my-project --prompt ""';
      parseOrchestratorCommands(response, codebases, workflows);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('logs synthesized_prompt_empty_discarded when --prompt has only whitespace', () => {
      // With --prompt "   ", the pattern matches whitespace; after .trim() rawPrompt is "".
      // The `if (promptMatch && !synthesizedPrompt)` branch executes and logs a warning.
      const response = '/invoke-workflow assist --project my-project --prompt "   "';
      parseOrchestratorCommands(response, codebases, workflows);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ workflowName: 'assist', projectName: 'my-project' }),
        'synthesized_prompt_empty_discarded'
      );
    });

    test('does not log warning when --prompt is absent', () => {
      const response = '/invoke-workflow assist --project my-project';
      parseOrchestratorCommands(response, codebases, workflows);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('does not log warning when --prompt has a non-empty value', () => {
      const response = '/invoke-workflow assist --project my-project --prompt "valid prompt"';
      parseOrchestratorCommands(response, codebases, workflows);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('--prompt must come after --project to match (--project before --prompt)', () => {
      // The regex requires --project before --prompt per spec
      const response = '/invoke-workflow assist --project my-project --prompt "test"';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).not.toBeNull();
      expect(result.workflowInvocation?.synthesizedPrompt).toBe('test');
    });

    test('command with --prompt before --project does NOT match', () => {
      // Per comment: "--project MUST appear before --prompt"
      const response = '/invoke-workflow assist --prompt "test" --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // The regex won't match when --prompt is before --project
      expect(result.workflowInvocation).toBeNull();
    });
  });

  // ─── Workflow validation ──────────────────────────────────────────────────────

  describe('workflow validation', () => {
    test('returns null workflowInvocation when workflow does not exist', () => {
      const response = '/invoke-workflow nonexistent-workflow --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
    });

    test('validates against actual workflow list', () => {
      const response = '/invoke-workflow plan --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.workflowName).toBe('plan');
    });

    test('returns null when workflows list is empty', () => {
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, []);

      expect(result.workflowInvocation).toBeNull();
    });
  });

  // ─── Project name matching ────────────────────────────────────────────────────

  describe('project name matching', () => {
    test('matches project by exact name (case-insensitive)', () => {
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.projectName).toBe('my-project');
    });

    test('matches project case-insensitively (uppercase input)', () => {
      const response = '/invoke-workflow assist --project MY-PROJECT';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.projectName).toBe('my-project');
    });

    test('matches project by last path segment (partial match)', () => {
      // "coleam00/Archon" matched by "Archon"
      const response = '/invoke-workflow assist --project Archon';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).not.toBeNull();
      expect(result.workflowInvocation?.projectName).toBe('coleam00/Archon');
    });

    test('partial match is case-insensitive', () => {
      const response = '/invoke-workflow assist --project archon';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.projectName).toBe('coleam00/Archon');
    });

    test('returns null workflowInvocation when project does not exist', () => {
      const response = '/invoke-workflow assist --project nonexistent-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
    });

    test('returns null when codebases list is empty', () => {
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, [], workflows);

      expect(result.workflowInvocation).toBeNull();
    });

    test('uses matched codebase name (not the input name) in result', () => {
      // Input "Archon" should resolve to full name "coleam00/Archon"
      const response = '/invoke-workflow assist --project Archon';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.projectName).toBe('coleam00/Archon');
    });
  });

  // ─── /register-project parsing ────────────────────────────────────────────────

  describe('/register-project parsing', () => {
    test('parses explicit folder intent and quoted paths without reconstructing a command', () => {
      expect(
        parseOrchestratorCommands(
          '/register-project --folder "My platform" "/home/user/my platform"',
          codebases,
          workflows
        ).projectRegistration
      ).toEqual({
        projectName: 'My platform',
        projectPath: '/home/user/my platform',
        folder: true,
      });
      expect(
        parseOrchestratorCommands('/register-project --folder only-name', codebases, workflows)
          .projectRegistration
      ).toBeNull();
    });

    test('parses a basic /register-project command', () => {
      const response = '/register-project my-app /home/user/projects/my-app';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration).not.toBeNull();
      expect(result.projectRegistration?.projectName).toBe('my-app');
      expect(result.projectRegistration?.projectPath).toBe('/home/user/projects/my-app');
    });

    test('parses /register-project with path containing spaces', () => {
      const response = '/register-project my-app /home/user/my projects/my-app dir';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration?.projectPath).toBe('/home/user/my projects/my-app dir');
    });

    test('parses /register-project in a multiline response', () => {
      const response =
        'I will register that project now.\n/register-project myapp /path/to/repo\nDone!';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration?.projectName).toBe('myapp');
      expect(result.projectRegistration?.projectPath).toBe('/path/to/repo');
    });

    test('returns null projectRegistration when command is absent', () => {
      const response = 'Just a regular message without any commands.';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration).toBeNull();
    });

    test('trims projectName and projectPath', () => {
      const response = '/register-project  myapp  /path/to/repo';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // The regex \S+ for name means no spaces in name anyway
      // Path is trimmed via .trim()
      expect(result.projectRegistration?.projectPath).toBe('/path/to/repo');
    });

    test('strips markdown bold from /register-project and parses correctly', () => {
      const response = '**/register-project myapp /home/user/projects/myapp**';
      const result = parseOrchestratorCommands(response, codebases, workflows);
      expect(result.projectRegistration?.projectName).toBe('myapp');
      expect(result.projectRegistration?.projectPath).toBe('/home/user/projects/myapp');
    });

    test('strips markdown bold from /register-project with quoted path', () => {
      const response =
        '**/register-project SaberEngine "/.archon/workspaces/b1skit/SaberEngine/source"**';
      const result = parseOrchestratorCommands(response, codebases, workflows);
      expect(result.projectRegistration?.projectName).toBe('SaberEngine');
      expect(result.projectRegistration?.projectPath).toBe(
        '/.archon/workspaces/b1skit/SaberEngine/source'
      );
    });

    test('strips markdown bold from /register-project in multiline response', () => {
      const response =
        'The project has been set up.\n\n**/register-project SaberEngine "/path/to/repo"**';
      const result = parseOrchestratorCommands(response, codebases, workflows);
      expect(result.projectRegistration?.projectName).toBe('SaberEngine');
      expect(result.projectRegistration?.projectPath).toBe('/path/to/repo');
    });

    test('strips single-asterisk italic from /register-project', () => {
      const response = '*/register-project myapp /path/to/app*';
      const result = parseOrchestratorCommands(response, codebases, workflows);
      expect(result.projectRegistration?.projectName).toBe('myapp');
      expect(result.projectRegistration?.projectPath).toBe('/path/to/app');
    });
  });

  // ─── No commands ──────────────────────────────────────────────────────────────

  describe('empty and no-command responses', () => {
    test('returns null for both when response has no commands', () => {
      const response = 'This is just a regular AI response with no commands.';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
      expect(result.projectRegistration).toBeNull();
    });

    test('returns null for both when response is empty string', () => {
      const result = parseOrchestratorCommands('', codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
      expect(result.projectRegistration).toBeNull();
    });

    test('returns null for both when response is only whitespace', () => {
      const result = parseOrchestratorCommands('   \n\n  ', codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
      expect(result.projectRegistration).toBeNull();
    });
  });

  // ─── Both commands present ────────────────────────────────────────────────────

  describe('both commands present in same response', () => {
    test('can parse both /invoke-workflow and /register-project in same response', () => {
      const response = [
        '/register-project newapp /path/to/newapp',
        '/invoke-workflow assist --project my-project',
      ].join('\n');
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration?.projectName).toBe('newapp');
      expect(result.workflowInvocation?.workflowName).toBe('assist');
    });
  });

  // ─── Pattern edge cases ───────────────────────────────────────────────────────

  describe('pattern edge cases and invalid inputs', () => {
    test('does not match /invoke-workflow without --project argument', () => {
      const response = '/invoke-workflow assist';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
    });

    test('does not match /invoke-workflow mid-line (requires start of line)', () => {
      // The regex uses /^.../m so it must be at start of a line
      const response = 'text /invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // "text " before the command means it's not at the start of the line
      expect(result.workflowInvocation).toBeNull();
    });

    test('does not match /register-project mid-line', () => {
      const response = 'here is /register-project myapp /path';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration).toBeNull();
    });

    test('does not match /register-project with only one argument', () => {
      const response = '/register-project only-name-no-path';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration).toBeNull();
    });

    test('does not match partial command like /invoke-workflo', () => {
      const response = '/invoke-workflo assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
    });

    test('case-sensitive command keywords (/INVOKE-WORKFLOW does not match)', () => {
      const response = '/INVOKE-WORKFLOW assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // The regex is case-sensitive for the command keyword
      expect(result.workflowInvocation).toBeNull();
    });

    test('case-sensitive command keywords (/REGISTER-PROJECT does not match)', () => {
      const response = '/REGISTER-PROJECT myapp /path/to/app';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration).toBeNull();
    });

    test('workflow name is taken from the matched workflow object (not input)', () => {
      // Even if input has odd casing, the returned workflowName should come from workflow.name
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // findWorkflow does exact match, so 'assist' must match workflow.name === 'assist'
      expect(result.workflowInvocation?.workflowName).toBe('assist');
    });
  });

  // ─── Complex real-world responses ────────────────────────────────────────────

  describe('complex real-world response patterns', () => {
    test('parses command embedded in longer reasoning text', () => {
      const response = [
        'Based on your request, I will run the implement workflow on your project.',
        'This will make the necessary changes.',
        '',
        '/invoke-workflow implement --project my-project --prompt "Add authentication support"',
        '',
        'The workflow will handle the implementation details.',
      ].join('\n');

      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.workflowName).toBe('implement');
      expect(result.workflowInvocation?.synthesizedPrompt).toBe('Add authentication support');
      expect(result.workflowInvocation?.remainingMessage).toContain('Based on your request');
    });

    test('handles response with tool indicator emojis before command', () => {
      // After batch-mode filtering, tool indicators are removed, but
      // parseOrchestratorCommands receives the filtered content
      const response =
        'I have analyzed the codebase.\n/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).not.toBeNull();
    });

    test('remainingMessage trims leading/trailing whitespace', () => {
      const response = '  \n  \nSome text here.\n\n/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // The remaining text (before the command) gets .trim()
      expect(result.workflowInvocation?.remainingMessage).toBe('Some text here.');
    });

    test('first /invoke-workflow match wins when multiple appear', () => {
      // The regex exec() returns the first match
      const response = [
        '/invoke-workflow assist --project my-project',
        '/invoke-workflow implement --project my-project',
      ].join('\n');
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.workflowName).toBe('assist');
    });

    test('first /register-project match wins when multiple appear', () => {
      const response = [
        '/register-project first-app /path/to/first',
        '/register-project second-app /path/to/second',
      ].join('\n');
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration?.projectName).toBe('first-app');
    });
  });
});
