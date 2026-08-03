import { describe, test, expect } from 'bun:test';
import { partitionWorkflows } from './partition-workflows';

const wf = (name: string): { name: string } => ({ name });

describe('partitionWorkflows', () => {
  test('empty recommendedNames → recommended is empty, rest === filtered', () => {
    const filtered = [wf('a'), wf('b'), wf('c')];
    const result = partitionWorkflows(filtered, []);
    expect(result.recommended).toEqual([]);
    expect(result.rest).toEqual(filtered);
  });

  test('reorders recommended into declared order regardless of input order', () => {
    const filtered = [wf('a'), wf('b'), wf('c'), wf('d')];
    const result = partitionWorkflows(filtered, ['c', 'a']);
    expect(result.recommended.map(w => w.name)).toEqual(['c', 'a']);
    expect(result.rest.map(w => w.name)).toEqual(['b', 'd']);
  });

  test('silently drops names not present in filtered (stale entries)', () => {
    const filtered = [wf('a'), wf('b')];
    const result = partitionWorkflows(filtered, ['b', 'ghost', 'a']);
    expect(result.recommended.map(w => w.name)).toEqual(['b', 'a']);
    expect(result.rest).toEqual([]);
  });

  test('all recommended filtered out → recommended is empty, rest stays as-is', () => {
    const filtered = [wf('x'), wf('y')];
    const result = partitionWorkflows(filtered, ['a', 'b']);
    expect(result.recommended).toEqual([]);
    expect(result.rest.map(w => w.name)).toEqual(['x', 'y']);
  });

  test('preserves rest input order', () => {
    const filtered = [wf('a'), wf('b'), wf('c'), wf('d'), wf('e')];
    const result = partitionWorkflows(filtered, ['c']);
    expect(result.recommended.map(w => w.name)).toEqual(['c']);
    expect(result.rest.map(w => w.name)).toEqual(['a', 'b', 'd', 'e']);
  });

  test('collapses duplicate recommended names to first occurrence', () => {
    const filtered = [wf('a'), wf('b'), wf('c')];
    const result = partitionWorkflows(filtered, ['b', 'a', 'b']);
    expect(result.recommended.map(w => w.name)).toEqual(['b', 'a']);
    expect(result.rest.map(w => w.name)).toEqual(['c']);
  });
});
