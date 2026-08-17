/**
 * Unit tests for the declared-input contract module (#2470, #2554).
 *
 * These cover the two pieces every invocation surface shares: the `name=value` grammar
 * a textual channel speaks, and the structured error data that lets a surface re-shape
 * a contract violation's remediation without parsing the message string.
 */
import { describe, test, expect } from 'bun:test';
import {
  parseInputAssignments,
  resolveDeclaredInputs,
  defaultRunInputs,
  WorkflowInputContractError,
} from './workflow-inputs';

describe('parseInputAssignments (#2554)', () => {
  test('parses one assignment per entry', () => {
    expect(parseInputAssignments(['scope=api', 'style=terse'])).toEqual({
      scope: 'api',
      style: 'terse',
    });
  });

  test('splits on the FIRST = so a value may contain =', () => {
    expect(parseInputAssignments(['query=a=b=c'])).toEqual({ query: 'a=b=c' });
  });

  test('accepts an empty value as a deliberate empty string', () => {
    expect(parseInputAssignments(['scope='])).toEqual({ scope: '' });
  });

  test('accepts hyphens and underscores in a name, matching the shared grammar', () => {
    expect(parseInputAssignments(['base-branch=dev', '_internal=1'])).toEqual({
      'base-branch': 'dev',
      _internal: '1',
    });
  });

  test('returns an empty map for no assignments', () => {
    expect(parseInputAssignments([])).toEqual({});
  });

  test('rejects an entry with no =', () => {
    expect(() => parseInputAssignments(['scope'])).toThrow(WorkflowInputContractError);
    expect(() => parseInputAssignments(['scope'])).toThrow(/expected 'name=value'/);
  });

  test('rejects a name that is not a valid input name', () => {
    // Leading digit and a dot are both outside INPUT_NAME_PATTERN.
    expect(() => parseInputAssignments(['1scope=api'])).toThrow(/Invalid input name/);
    expect(() => parseInputAssignments(['my.key=api'])).toThrow(/Invalid input name/);
    expect(() => parseInputAssignments(['=api'])).toThrow(/Invalid input name/);
  });

  test('never echoes the value back in a bad-name error', () => {
    // The message reaches the user's terminal; the name identifies the flag to fix,
    // while the value after `=` is user content and often a secret.
    expect(() => parseInputAssignments(['1bad=hunter2'])).toThrow(/'1bad'/);
    expect(() => parseInputAssignments(['1bad=hunter2'])).not.toThrow(/hunter2/);
  });

  test('rejects a duplicate name rather than silently taking the last', () => {
    expect(() => parseInputAssignments(['scope=api', 'scope=web'])).toThrow(
      /Duplicate input 'scope'/
    );
  });
});

describe('resolveDeclaredInputs structured error data (#2554)', () => {
  test('carries the undeclared names on the error', () => {
    let caught: unknown;
    try {
      resolveDeclaredInputs({ stlye: 'x' }, { style: {} }, "Node 'n'", 'block');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowInputContractError);
    const err = caught as WorkflowInputContractError;
    expect(err.undeclared).toEqual(['stlye']);
    expect(err.missingRequired).toEqual([]);
  });

  test('carries the missing required names on the error', () => {
    let caught: unknown;
    try {
      resolveDeclaredInputs({}, { diff: { required: true }, scope: { required: true } }, 'C', 'b');
    } catch (err) {
      caught = err;
    }
    const err = caught as WorkflowInputContractError;
    expect(err.missingRequired.slice().sort()).toEqual(['diff', 'scope']);
    expect(err.undeclared).toEqual([]);
  });

  test('a grammar error carries neither list', () => {
    let caught: unknown;
    try {
      parseInputAssignments(['nope']);
    } catch (err) {
      caught = err;
    }
    const err = caught as WorkflowInputContractError;
    expect(err.undeclared).toEqual([]);
    expect(err.missingRequired).toEqual([]);
  });
});

describe('defaultRunInputs', () => {
  test('synthesizes declared defaults only, never required inputs', () => {
    expect(defaultRunInputs({ style: { default: 'strict' }, diff: { required: true } })).toEqual({
      style: 'strict',
    });
  });

  test('is undefined when nothing is declared or nothing is defaulted', () => {
    expect(defaultRunInputs(undefined)).toBeUndefined();
    expect(defaultRunInputs({ diff: { required: true } })).toBeUndefined();
  });
});
