import { describe, it, expect } from 'bun:test';
import { extractArtifactInfo } from './WorkflowResultCard';

describe('extractArtifactInfo', () => {
  it('should extract runId and filename from standard artifact path with forward slashes', () => {
    const text = 'artifacts/runs/64d87e85-2581-41aa-8407-233018ba2a1b/review/fix-report.md';
    const result = extractArtifactInfo(text);
    expect(result).toEqual({
      runId: '64d87e85-2581-41aa-8407-233018ba2a1b',
      filename: 'review/fix-report.md',
    });
  });

  it('should extract runId and filename from artifact path with backslashes', () => {
    const text = 'artifacts\\runs\\64d87e85-2581-41aa-8407-233018ba2a1b\\summary.json';
    const result = extractArtifactInfo(text);
    expect(result).toEqual({
      runId: '64d87e85-2581-41aa-8407-233018ba2a1b',
      filename: 'summary.json',
    });
  });

  it('should extract runId and filename from embedded path in text', () => {
    const text =
      'Saved report at /workspace/project/artifacts/runs/a1b2c3d4-e5f6-7890-abcd-ef1234567890/output.txt';
    const result = extractArtifactInfo(text);
    expect(result).toEqual({
      runId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      filename: 'output.txt',
    });
  });

  it('should return null when path contains path traversal components (..)', () => {
    const text = 'artifacts/runs/64d87e85-2581-41aa-8407-233018ba2a1b/../secret.env';
    const result = extractArtifactInfo(text);
    expect(result).toBeNull();
  });

  it('should return null for non-artifact text', () => {
    expect(extractArtifactInfo('hello world')).toBeNull();
    expect(extractArtifactInfo('/var/log/app.log')).toBeNull();
    expect(extractArtifactInfo('')).toBeNull();
  });
});
