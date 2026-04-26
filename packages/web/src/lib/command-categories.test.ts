import { describe, expect, test } from 'bun:test';
import type { CommandEntry } from '@/lib/api';
import { categorizeCommands } from './command-categories';
import { commandCategoryLabel } from './i18n';

function command(name: string, source: CommandEntry['source'] = 'bundled'): CommandEntry {
  return { name, source };
}

describe('categorizeCommands', () => {
  test('keeps English internal category keys for bundled commands', () => {
    const categories = categorizeCommands([
      command('archon-investigate-issue'),
      command('archon-create-plan'),
      command('archon-implement'),
      command('archon-code-review-agent'),
      command('archon-create-pr'),
      command('archon-synthesize-review'),
      command('archon-validate'),
      command('archon-assist'),
    ]);

    expect(categories.map(category => category.name)).toEqual([
      'Investigation',
      'Planning',
      'Implementation',
      'Code Review',
      'PR Lifecycle',
      'Review Synthesis',
      'Validation',
      'Utilities',
    ]);
  });

  test('puts project commands first without localizing internal category names', () => {
    const categories = categorizeCommands([
      command('archon-implement'),
      command('local-project-command', 'project'),
      command('archon-validate'),
    ]);

    expect(categories.map(category => category.name)).toEqual([
      'Project',
      'Implementation',
      'Validation',
    ]);
    expect(categories[0]?.commands.map(cmd => cmd.name)).toEqual(['local-project-command']);
  });

  test('exposes Korean display labels through commandCategoryLabel', () => {
    expect(commandCategoryLabel('Project')).toBe('프로젝트');
    expect(commandCategoryLabel('Investigation')).toBe('조사');
    expect(commandCategoryLabel('Planning')).toBe('계획');
    expect(commandCategoryLabel('Implementation')).toBe('구현');
    expect(commandCategoryLabel('Code Review')).toBe('코드 리뷰');
    expect(commandCategoryLabel('PR Lifecycle')).toBe('PR 수명주기');
    expect(commandCategoryLabel('Review Synthesis')).toBe('리뷰 종합');
    expect(commandCategoryLabel('Validation')).toBe('검증');
    expect(commandCategoryLabel('Utilities')).toBe('유틸리티');
  });

  test('falls back to the original category when no Korean label exists', () => {
    expect(commandCategoryLabel('Custom Category')).toBe('Custom Category');
  });
});
