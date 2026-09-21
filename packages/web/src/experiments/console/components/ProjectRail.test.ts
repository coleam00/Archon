import { describe, expect, test } from 'bun:test';
import { removeProjectFromRail } from './ProjectRail';

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
