import { describe, test, expect } from 'bun:test';
import { runPreflightGates } from './preflight';
import type { BundleFile } from './bundle';

const BUNDLE: BundleFile[] = [
  {
    repoPath: '.archon/marketplace/my-flow/my-flow.yaml',
    content:
      'name: my-flow\ndescription: A test workflow\nnodes:\n  - id: a\n    type: bash\n    command: echo hi\n',
  },
  { repoPath: '.archon/marketplace/my-flow/commands/helper.md', content: '# Helper\n' },
];

describe('runPreflightGates', () => {
  test('passes when schema is valid and security severity is none', () => {
    const result = runPreflightGates(BUNDLE);
    expect(result.passed).toBe(true);
    expect(result.gates).toHaveLength(2);
    expect(result.gates.find(g => g.name === 'schema-validate')?.passed).toBe(true);
    expect(result.gates.find(g => g.name === 'security-scan')?.passed).toBe(true);
  });

  test('blocks when schema validation fails', () => {
    const bundle: BundleFile[] = [
      {
        repoPath: '.archon/marketplace/bad-flow/bad-flow.yaml',
        content:
          'name: bad-flow\ndescription: A test workflow\nnodes:\n  - id: a\n    type: bash\n    command: echo hi\n    depends_on: [missing]\n',
      },
    ];
    const result = runPreflightGates(bundle);
    expect(result.passed).toBe(false);
    const schemaGate = result.gates.find(g => g.name === 'schema-validate');
    expect(schemaGate?.passed).toBe(false);
    const detail = schemaGate?.detail as { files: { name: string; errors: string[] }[] };
    expect(detail.files[0]?.errors[0]).toContain('missing');
  });

  test('strips the bundle prefix so file names shown to the gates are relative to source/', () => {
    const result = runPreflightGates(BUNDLE);
    const schemaGate = result.gates.find(g => g.name === 'schema-validate');
    const detail = schemaGate?.detail as { files: { name: string }[] };
    expect(detail.files[0]?.name).toBe('my-flow.yaml');
  });

  test('blocks when security severity is anything other than none', () => {
    const bundle: BundleFile[] = [
      ...BUNDLE,
      { repoPath: '.archon/marketplace/my-flow/scripts/danger.ts', content: 'eval(userInput)\n' },
    ];
    const result = runPreflightGates(bundle);
    expect(result.passed).toBe(false);
    const securityGate = result.gates.find(g => g.name === 'security-scan');
    expect(securityGate?.passed).toBe(false);
    expect((securityGate?.detail as { finding_count: number }).finding_count).toBe(1);
  });

  test('scans every bundle file, not just the workflow yaml', () => {
    const bundle: BundleFile[] = [
      {
        repoPath: '.archon/marketplace/my-flow/my-flow.yaml',
        content: 'nodes:\n  - id: a\n    type: bash\n    command: echo hi\n',
      },
      { repoPath: '.archon/marketplace/my-flow/scripts/danger.ts', content: 'sudo rm -rf /\n' },
    ];
    const result = runPreflightGates(bundle);
    const securityGate = result.gates.find(g => g.name === 'security-scan');
    expect((securityGate?.detail as { finding_count: number }).finding_count).toBe(1);
  });
});
