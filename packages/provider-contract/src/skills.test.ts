import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { declaredSkillRoots, type SkillDiscovery } from './skills';

const discovery: SkillDiscovery = {
  project: ['.stub/skills', '.shared/skills'],
  user: ['skills'],
  userDirectory: { env: 'STUB_CONFIG_DIR', home: '.stub' },
};

describe('declaredSkillRoots', () => {
  const saved = { HOME: process.env.HOME, STUB_CONFIG_DIR: process.env.STUB_CONFIG_DIR };

  beforeEach(() => {
    process.env.HOME = '/home/u';
    delete process.env.STUB_CONFIG_DIR;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('lists project roots then user roots, in declared order', () => {
    expect(declaredSkillRoots(discovery, '/repo')).toEqual([
      join('/repo', '.stub/skills'),
      join('/repo', '.shared/skills'),
      join('/home/u/.stub', 'skills'),
    ]);
  });

  test('gates project and user roots independently', () => {
    expect(declaredSkillRoots(discovery, '/repo', { includeProject: false })).toEqual([
      join('/home/u/.stub', 'skills'),
    ]);
    expect(declaredSkillRoots(discovery, '/repo', { includeUser: false })).toEqual([
      join('/repo', '.stub/skills'),
      join('/repo', '.shared/skills'),
    ]);
  });

  test('the run environment beats process.env, which beats the home fallback', () => {
    const user = (env?: Record<string, string>): string[] =>
      declaredSkillRoots(discovery, '/repo', { includeProject: false, env });
    process.env.STUB_CONFIG_DIR = '/from-process';
    expect(user({ STUB_CONFIG_DIR: '/from-run' })).toEqual([join('/from-run', 'skills')]);
    expect(user()).toEqual([join('/from-process', 'skills')]);
    delete process.env.STUB_CONFIG_DIR;
    expect(user()).toEqual([join('/home/u/.stub', 'skills')]);
  });

  test('without a user directory, user roots are relative to home', () => {
    expect(
      declaredSkillRoots({ project: [], user: ['.agents/skills'] }, '/repo', {
        env: { STUB_CONFIG_DIR: '/ignored' },
      })
    ).toEqual([join('/home/u', '.agents/skills')]);
  });
});
