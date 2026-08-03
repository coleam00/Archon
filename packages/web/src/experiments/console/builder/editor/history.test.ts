import { describe, test, expect } from 'bun:test';
import {
  COALESCE_MS,
  canRedo,
  canUndo,
  createHistory,
  pushSnapshot,
  redo,
  undo,
  type Snapshot,
} from './history';
import type { BuilderWorkflow } from '../types';

function snap(name: string): Snapshot {
  const workflow: BuilderWorkflow = { name, description: '', meta: {}, nodes: [] };
  return { workflow, positions: new Map() };
}

describe('history', () => {
  test('starts empty', () => {
    const h = createHistory();
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
    expect(undo(h, snap('live'))).toBeNull();
    expect(redo(h, snap('live'))).toBeNull();
  });

  test('push then undo restores the pre-edit snapshot; redo restores the edit', () => {
    let h = createHistory();
    h = pushSnapshot(h, 'edit', snap('v1'), 1000);

    const undone = undo(h, snap('v2'));
    expect(undone).not.toBeNull();
    expect(undone?.snapshot.workflow.name).toBe('v1');

    const redone = redo(undone?.history ?? h, undone?.snapshot ?? snap('v1'));
    expect(redone?.snapshot.workflow.name).toBe('v2');
  });

  test('same-kind pushes inside the window coalesce into one entry', () => {
    let h = createHistory();
    h = pushSnapshot(h, 'patch:n1', snap('v1'), 1000);
    h = pushSnapshot(h, 'patch:n1', snap('v2'), 1000 + COALESCE_MS - 1);
    h = pushSnapshot(h, 'patch:n1', snap('v3'), 1000 + 2 * (COALESCE_MS - 1));
    expect(h.past.length).toBe(1);
    // Undo lands on the FIRST pre-edit snapshot of the burst.
    expect(undo(h, snap('v4'))?.snapshot.workflow.name).toBe('v1');
  });

  test('the coalesce window slides on every attempt', () => {
    let h = createHistory();
    h = pushSnapshot(h, 'drag', snap('v1'), 0);
    // 10 ticks, each 100ms apart — a continuous drag stays one entry even
    // though the last tick is far beyond the first one's window.
    for (let i = 1; i <= 10; i += 1) {
      h = pushSnapshot(h, 'drag', snap(`v${String(i)}`), i * 100);
    }
    expect(h.past.length).toBe(1);
  });

  test('a pause longer than the window starts a new entry', () => {
    let h = createHistory();
    h = pushSnapshot(h, 'drag', snap('v1'), 0);
    h = pushSnapshot(h, 'drag', snap('v2'), COALESCE_MS + 1);
    expect(h.past.length).toBe(2);
  });

  test('a different kind never coalesces', () => {
    let h = createHistory();
    h = pushSnapshot(h, 'drag', snap('v1'), 0);
    h = pushSnapshot(h, 'add-node', snap('v2'), 1);
    expect(h.past.length).toBe(2);
  });

  test('pushing clears the redo stack', () => {
    let h = createHistory();
    h = pushSnapshot(h, 'a', snap('v1'), 0);
    const undone = undo(h, snap('v2'));
    expect(undone).not.toBeNull();
    if (undone === null) return;
    expect(canRedo(undone.history)).toBe(true);
    const pushed = pushSnapshot(undone.history, 'b', snap('v1b'), 5000);
    expect(canRedo(pushed)).toBe(false);
  });

  test('undo resets the coalescing window (next same-kind edit gets its own entry)', () => {
    let h = createHistory();
    h = pushSnapshot(h, 'patch:n1', snap('v1'), 1000);
    const undone = undo(h, snap('v2'));
    expect(undone).not.toBeNull();
    if (undone === null) return;
    const next = pushSnapshot(undone.history, 'patch:n1', snap('v1'), 1001);
    expect(next.past.length).toBe(1);
    expect(canRedo(next)).toBe(false);
  });

  test('undo/redo ordering across multiple entries', () => {
    let h = createHistory();
    h = pushSnapshot(h, 'a', snap('v1'), 0);
    h = pushSnapshot(h, 'b', snap('v2'), 1000);
    h = pushSnapshot(h, 'c', snap('v3'), 2000);

    const u1 = undo(h, snap('v4'));
    expect(u1?.snapshot.workflow.name).toBe('v3');
    const u2 = undo(u1?.history ?? h, u1?.snapshot ?? snap('x'));
    expect(u2?.snapshot.workflow.name).toBe('v2');
    const r1 = redo(u2?.history ?? h, u2?.snapshot ?? snap('x'));
    expect(r1?.snapshot.workflow.name).toBe('v3');
    const r2 = redo(r1?.history ?? h, r1?.snapshot ?? snap('x'));
    expect(r2?.snapshot.workflow.name).toBe('v4');
    expect(canRedo(r2?.history ?? h)).toBe(false);
  });
});
