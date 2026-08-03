import { describe, test, expect } from 'bun:test';
import {
  serverErrorToIssues,
  serverValidationToIssues,
  validationFailureToIssues,
  clientIssue,
  errorToIssues,
  errorDetail,
  blockingErrors,
  isReadOnlySource,
  saveTargetFor,
  isValidWorkflowName,
  renameReasonMessage,
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

  test('falls back to a verb-neutral status message when the snippet is empty', () => {
    const err = new HttpError(500, '/api/workflows/foo', '');
    expect(serverErrorToIssues(err)[0]?.message).toBe('Request failed (500)');
  });

  test('empty parsed error field falls back to the raw snippet (not the empty field)', () => {
    const body = JSON.stringify({ error: '', detail: 'internal context' });
    const err = new HttpError(400, '/api/workflows/foo', body);
    expect(serverErrorToIssues(err)[0]?.message).toBe(body);
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

describe('validationFailureToIssues', () => {
  test('maps present errors through', () => {
    const issues = validationFailureToIssues(['boom']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toBe('boom');
  });

  test('guarantees a fallback issue when errors is empty or undefined (never silent)', () => {
    for (const input of [[], undefined]) {
      const issues = validationFailureToIssues(input);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.source).toBe('server');
      expect(issues[0]?.severity).toBe('error');
      expect(issues[0]?.message).toContain('no error details');
    }
  });
});

describe('clientIssue', () => {
  test('mints a client-instant error issue', () => {
    const issue = clientIssue('save.blocked', 'nope');
    expect(issue.source).toBe('client-instant');
    expect(issue.severity).toBe('error');
    expect(issue.rule).toBe('save.blocked');
    expect(issue.message).toBe('nope');
  });
});

describe('errorToIssues', () => {
  test('HttpError delegates to serverErrorToIssues', () => {
    const err = new HttpError(400, '/api/workflows/foo', JSON.stringify({ error: 'bad' }));
    const issues = errorToIssues(err, 'save.failed', 'fallback');
    expect(issues[0]?.source).toBe('server');
    expect(issues[0]?.message).toBe('bad');
  });

  test('generic Error uses e.message and the caller-supplied rule', () => {
    const issues = errorToIssues(new TypeError('Failed to fetch'), 'save.failed', 'unknown');
    expect(issues[0]?.message).toBe('Failed to fetch');
    expect(issues[0]?.rule).toBe('save.failed');
  });

  test('non-Error thrown value uses the fallback string', () => {
    const issues = errorToIssues('string literal', 'save.failed', 'unknown error');
    expect(issues[0]?.message).toBe('unknown error');
  });
});

describe('errorDetail', () => {
  test('HttpError → parsed server message', () => {
    const err = new HttpError(403, '/api/workflows/foo', JSON.stringify({ error: 'denied' }));
    expect(errorDetail(err)).toBe('denied');
  });

  test('generic Error → message; non-Error → String()', () => {
    expect(errorDetail(new Error('boom'))).toBe('boom');
    expect(errorDetail(42)).toBe('42');
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

  test('empty in → empty out', () => {
    expect(blockingErrors([])).toEqual([]);
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

describe('renameReasonMessage', () => {
  test('collision interpolates the target name', () => {
    expect(renameReasonMessage('collision', 'my-flow')).toContain('"my-flow"');
  });

  test('invalid-name interpolates the name and lists the constraints (incl. backslash)', () => {
    const msg = renameReasonMessage('invalid-name', '../evil');
    expect(msg).toContain('"../evil"');
    expect(msg).toContain('..');
    expect(msg).toContain('\\');
  });

  test('noop is a fixed string', () => {
    expect(renameReasonMessage('noop', 'x')).toBe('The new name is the same as the current one.');
  });
});

describe('planRename', () => {
  test('valid distinct non-colliding rename → ok', () => {
    const plan = planRename({ from: 'old', to: 'new', existingNames: ['old', 'other'] });
    expect(plan).toEqual({ ok: true });
  });

  test('collision against an existing name is blocked', () => {
    const plan = planRename({ from: 'old', to: 'other', existingNames: ['old', 'other'] });
    expect(plan).toEqual({ ok: false, reason: 'collision' });
  });

  test('no-op rename (to === from) is blocked, even when the name is in the list', () => {
    const plan = planRename({ from: 'old', to: 'old', existingNames: ['old', 'other'] });
    expect(plan).toEqual({ ok: false, reason: 'noop' });
  });

  test('invalid target name is blocked, and takes precedence over collision', () => {
    const plan = planRename({ from: 'old', to: '../evil', existingNames: ['old', '../evil'] });
    expect(plan).toEqual({ ok: false, reason: 'invalid-name' });
  });
});
