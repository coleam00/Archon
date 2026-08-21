import { describe, test, expect } from 'bun:test';
import {
  validateMarketplaceWorkflowFiles,
  scanMarketplaceFilesForSecurityIssues,
  type MarketplaceFile,
} from './marketplace-checks';

describe('validateMarketplaceWorkflowFiles', () => {
  test('reports no yaml files when the file list is empty', () => {
    const result = validateMarketplaceWorkflowFiles([]);
    expect(result).toEqual({ valid: true, files: [], note: 'no yaml files found' });
  });

  test('reports no yaml files when nothing has a yaml/yml extension', () => {
    const files: MarketplaceFile[] = [{ name: 'commands/helper.md', content: '# Helper\n' }];
    const result = validateMarketplaceWorkflowFiles(files);
    expect(result).toEqual({ valid: true, files: [], note: 'no yaml files found' });
  });

  test('reports no workflow yaml files when yaml exists but none look like a workflow', () => {
    const files: MarketplaceFile[] = [{ name: 'brand.yaml', content: 'color: blue\n' }];
    const result = validateMarketplaceWorkflowFiles(files);
    expect(result).toEqual({
      valid: true,
      files: [],
      note: 'no workflow yaml files (no top-level nodes:)',
    });
  });

  test('validates a well-formed workflow yaml as valid', () => {
    const files: MarketplaceFile[] = [
      {
        name: 'my-flow.yaml',
        content: [
          'name: my-flow',
          'description: A test workflow',
          'nodes:',
          '  - id: a',
          '    type: bash',
          '    command: echo hi',
          '',
        ].join('\n'),
      },
    ];
    const result = validateMarketplaceWorkflowFiles(files);
    expect(result.valid).toBe(true);
    expect(result.files).toEqual([{ name: 'my-flow.yaml', valid: true, errors: [] }]);
  });

  test('reports invalid: false with the parse error for a malformed workflow', () => {
    const files: MarketplaceFile[] = [
      {
        name: 'bad-flow.yaml',
        content: [
          'name: bad-flow',
          'description: A test workflow',
          'nodes:',
          '  - id: a',
          '    type: bash',
          '    command: echo hi',
          '    depends_on: [missing-node]',
          '',
        ].join('\n'),
      },
    ];
    const result = validateMarketplaceWorkflowFiles(files);
    expect(result.valid).toBe(false);
    expect(result.files[0]?.valid).toBe(false);
    expect(result.files[0]?.errors[0]).toContain('missing-node');
  });

  test('skips non-workflow yaml alongside a valid workflow yaml', () => {
    const files: MarketplaceFile[] = [
      { name: 'brand.yaml', content: 'color: blue\n' },
      {
        name: 'my-flow.yaml',
        content: [
          'name: my-flow',
          'description: A test workflow',
          'nodes:',
          '  - id: a',
          '    type: bash',
          '    command: echo hi',
          '',
        ].join('\n'),
      },
    ];
    const result = validateMarketplaceWorkflowFiles(files);
    expect(result.valid).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.name).toBe('my-flow.yaml');
  });
});

describe('scanMarketplaceFilesForSecurityIssues', () => {
  test('reports severity none with zero findings for clean files', () => {
    const files: MarketplaceFile[] = [
      { name: 'my-flow.yaml', content: 'nodes:\n  - id: a\n    type: bash\n' },
    ];
    const result = scanMarketplaceFilesForSecurityIssues(files);
    expect(result).toEqual({ severity: 'none', finding_count: 0, findings: [] });
  });

  test('flags a critical rce pattern', () => {
    const files: MarketplaceFile[] = [{ name: 'scripts/x.ts', content: 'eval(userInput)\n' }];
    const result = scanMarketplaceFilesForSecurityIssues(files);
    expect(result.severity).toBe('critical');
    expect(result.finding_count).toBe(1);
    expect(result.findings[0]).toMatchObject({ file: 'scripts/x.ts', line: 1, category: 'rce' });
  });

  test('flags a medium path_escape pattern without escalating overall severity past its map', () => {
    const files: MarketplaceFile[] = [
      { name: 'scripts/y.ts', content: 'readFileSync("../../etc/passwd")\n' },
    ];
    const result = scanMarketplaceFilesForSecurityIssues(files);
    expect(result.severity).toBe('medium');
  });

  test('takes the max severity across multiple findings', () => {
    const files: MarketplaceFile[] = [
      { name: 'a.ts', content: 'sudo rm -rf /\n' }, // high (unsafe_permissions)
      { name: 'b.ts', content: 'eval(x)\n' }, // critical (rce)
    ];
    const result = scanMarketplaceFilesForSecurityIssues(files);
    expect(result.severity).toBe('critical');
    expect(result.finding_count).toBe(2);
  });

  test('scans every file regardless of extension', () => {
    const files: MarketplaceFile[] = [{ name: 'README', content: 'eval(x)\n' }];
    const result = scanMarketplaceFilesForSecurityIssues(files);
    expect(result.finding_count).toBe(1);
  });
});
