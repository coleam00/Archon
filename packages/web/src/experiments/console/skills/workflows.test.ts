import { describe, test, expect } from 'bun:test';
import { buildWorkflowPath, buildSavePath } from './workflows';

describe('buildWorkflowPath', () => {
  test('encodes both name and cwd', () => {
    expect(buildWorkflowPath('my-flow', 'D:/Dynamous/Archon')).toBe(
      '/api/workflows/my-flow?cwd=D%3A%2FDynamous%2FArchon'
    );
  });

  test('encodes special characters in the name', () => {
    expect(buildWorkflowPath('a b', '/repo')).toBe('/api/workflows/a%20b?cwd=%2Frepo');
  });
});

describe('buildSavePath', () => {
  test('appends &source=project to the encoded cwd query', () => {
    expect(buildSavePath('my-flow', '/repo', 'project')).toBe(
      '/api/workflows/my-flow?cwd=%2Frepo&source=project'
    );
  });

  test('appends &source=global', () => {
    expect(buildSavePath('my-flow', '/repo', 'global')).toBe(
      '/api/workflows/my-flow?cwd=%2Frepo&source=global'
    );
  });
});
