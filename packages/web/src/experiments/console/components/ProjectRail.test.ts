import { describe, expect, test } from 'bun:test';
import { removeProjectFromRail, renameProjectInRail } from './ProjectRail';

describe('removeProjectFromRail', () => {
  test('keeps the selected project route when removal fails', async () => {
    let invalidations = 0;
    let navigations = 0;

    const removal = removeProjectFromRail('project-1', 'project-1', {
      remove: () => Promise.reject(new Error('Server returned 500')),
      invalidateProjects: () => {
        invalidations++;
      },
      navigateToOverview: () => {
        navigations++;
      },
    });

    await expect(removal).rejects.toThrow('Server returned 500');
    expect(invalidations).toBe(0);
    expect(navigations).toBe(0);
  });

  test('invalidates before leaving a successfully removed selected project', async () => {
    const effects: string[] = [];

    await removeProjectFromRail('project-1', 'project-1', {
      remove: async () => {
        effects.push('removed');
      },
      invalidateProjects: () => {
        effects.push('invalidated');
      },
      navigateToOverview: () => {
        effects.push('navigated');
      },
    });

    expect(effects).toEqual(['removed', 'invalidated', 'navigated']);
  });
});

describe('renameProjectInRail', () => {
  test('invalidates nothing when the server refuses the rename', async () => {
    let invalidations = 0;

    const rename = renameProjectInRail('project-1', 'qes', {
      rename: () => Promise.reject(new Error('A project named "qes" is already registered')),
      invalidateProject: () => {
        invalidations++;
      },
    });

    await expect(rename).rejects.toThrow('already registered');
    expect(invalidations).toBe(0);
  });

  test('invalidates the renamed project after the server accepts it', async () => {
    const effects: string[] = [];

    await renameProjectInRail('project-1', 'qes', {
      rename: async (id, name) => {
        effects.push(`renamed ${id} to ${name}`);
      },
      invalidateProject: id => {
        effects.push(`invalidated ${id}`);
      },
    });

    expect(effects).toEqual(['renamed project-1 to qes', 'invalidated project-1']);
  });
});
