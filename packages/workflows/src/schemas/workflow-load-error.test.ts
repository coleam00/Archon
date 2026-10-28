import { describe, expect, it } from 'bun:test';
import { findWorkflowLoadError, type WorkflowLoadError } from './workflow';

describe('findWorkflowLoadError', () => {
  const declared: WorkflowLoadError = {
    filename: '/workflows/file.yaml',
    workflowName: 'archon-review',
    error: 'Duplicate workflow name',
    errorType: 'validation_error',
  };
  const unnamed: WorkflowLoadError = {
    filename: '/workflows/Review.yml',
    error: 'Invalid YAML',
    errorType: 'parse_error',
  };

  it('attributes a declared error only to its exact workflow name', () => {
    expect(findWorkflowLoadError([declared], 'archon-review')).toBe(declared);
    for (const target of ['ARCHON-REVIEW', 'review', '/workflows/file']) {
      expect(findWorkflowLoadError([declared], target)).toBeUndefined();
    }
  });

  it('attributes an unnamed error only to its exact filename without the extension', () => {
    expect(findWorkflowLoadError([unnamed], '/workflows/Review')).toBe(unnamed);
    for (const target of ['/workflows/review', 'Review', 'review']) {
      expect(findWorkflowLoadError([unnamed], target)).toBeUndefined();
    }
  });

  it('prefers a declared identity over an unnamed filename', () => {
    const named = { ...declared, workflowName: '/workflows/Review' };
    expect(findWorkflowLoadError([unnamed, named], '/workflows/Review')).toBe(named);
  });
});
