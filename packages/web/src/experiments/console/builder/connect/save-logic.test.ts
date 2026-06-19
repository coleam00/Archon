import { describe, test, expect } from 'bun:test';
import {
  serverErrorToIssues,
  serverValidationToIssues,
  blockingErrors,
  isReadOnlySource,
  saveTargetFor,
  isValidWorkflowName,
  planRename,
} from './save-logic';
import { makeIssue } from '../validation/make-issue';
import { HttpError } from '../../lib/http';
import type { Issue } from '../types';

describe('serverErrorToIssues', () => {
  test('parses apiError JSON into error: detail and tags source:server', () => {
    const err = new HttpError(
      400,
      '/api/workflows/foo',
      JSON.stringify({ error: 'Workflow definition is invalid', detail: 'dangling depends_on' })
    );
    const issues = serverErrorToIssues(err);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.source).toBe('server');
    expect(issues[0]?.severity).toBe('error');
    expect(issues[0]?.message).toBe('Workflow definition is invalid: dangling depends_on');
  });

  test('uses error alone when no detail', () => {
    const err = new HttpError(
      400,
      '/api/workflows/foo',
      JSON.stringify({ error: 'Cannot delete bundled default workflow: foo' })
    );
    expect(serverErrorToIssues(err)[0]?.message).toBe(
      'Cannot delete bundled default workflow: foo'
    );
  });

  test('falls back to the raw snippet when the body is truncated / non-JSON', () => {
    const err = new HttpError(400, '/api/workflows/foo', '{"error":"Workflow definition is inval');
    expect(serverErrorToIssues(err)[0]?.message).toBe('{"error":"Workflow definition is inval');
  });

  test('falls back to a status message when the snippet is empty', () => {
    const err = new HttpError(500, '/api/workflows/foo', '');
    expect(serverErrorToIssues(err)[0]?.message).toBe('Save failed (500)');
  });
});

describe('serverValidationToIssues', () => {
  test('maps each error string into a source:server error issue', () => {
    const issues = serverValidationToIssues([
      "Missing required field 'description'",
      'Unknown node id',
    ]);
    expect(issues).toHaveLength(2);
    expect(issues.every(i => i.source === 'server' && i.severity === 'error')).toBe(true);
    expect(issues[0]?.message).toBe("Missing required field 'description'");
  });

  test('empty errors → no issues', () => {
    expect(serverValidationToIssues([])).toEqual([]);
  });
});

describe('blockingErrors', () => {
  test('keeps only severity:error', () => {
    const issues: Issue[] = [
      makeIssue({ rule: 'a', severity: 'error', source: 'server', message: 'boom', path: {} }),
      makeIssue({ rule: 'b', severity: 'warning', source: 'server', message: 'meh', path: {} }),
      makeIssue({ rule: 'c', severity: 'info', source: 'server', message: 'fyi', path: {} }),
    ];
    const blocking = blockingErrors(issues);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]?.rule).toBe('a');
  });
});

describe('isReadOnlySource / saveTargetFor', () => {
  test('only bundled is read-only', () => {
    expect(isReadOnlySource('bundled')).toBe(true);
    expect(isReadOnlySource('project')).toBe(false);
    expect(isReadOnlySource('global')).toBe(false);
  });

  test('bundled saves as project override, project stays project, global stays global', () => {
    expect(saveTargetFor('bundled')).toBe('project');
    expect(saveTargetFor('project')).toBe('project');
    expect(saveTargetFor('global')).toBe('global');
  });
});

describe('isValidWorkflowName', () => {
  test('accepts a kebab name and a dotted mid-name (server accepts a.b)', () => {
    expect(isValidWorkflowName('my-flow')).toBe(true);
    expect(isValidWorkflowName('a.b')).toBe(true);
  });

  test('rejects path traversal, separators, leading dot, and empty', () => {
    expect(isValidWorkflowName('../x')).toBe(false);
    expect(isValidWorkflowName('a/b')).toBe(false);
    expect(isValidWorkflowName('a\\b')).toBe(false);
    expect(isValidWorkflowName('.hidden')).toBe(false);
    expect(isValidWorkflowName('')).toBe(false);
  });
});

describe('planRename', () => {
  test('valid distinct non-colliding rename → put then delete', () => {
    const plan = planRename({ from: 'old', to: 'new', existingNames: ['old', 'other'] });
    expect(plan).toEqual({ ok: true, steps: ['put', 'delete'] });
  });

  test('collision against an existing name is blocked', () => {
    const plan = planRename({ from: 'old', to: 'other', existingNames: ['old', 'other'] });
    expect(plan).toEqual({ ok: false, reason: 'collision' });
  });

  test('no-op rename (to === from) is blocked', () => {
    const plan = planRename({ from: 'old', to: 'old', existingNames: ['old'] });
    expect(plan).toEqual({ ok: false, reason: 'noop' });
  });

  test('invalid target name is blocked', () => {
    const plan = planRename({ from: 'old', to: '../evil', existingNames: ['old'] });
    expect(plan).toEqual({ ok: false, reason: 'invalid-name' });
  });
});
