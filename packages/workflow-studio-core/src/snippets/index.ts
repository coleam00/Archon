// Snippet API folded in from the former @archon-studio/fixtures package.
// Source YAML lives under archon-workflow-studio's snippets/{starters,patterns}/*.yaml
// and was inlined into snippet-data.generated.ts via the upstream build-snippet-data
// script. Regenerate upstream and recopy snippet-data.generated.ts if snippets change.
import { SNIPPET_DATA } from './snippet-data.generated';

export function loadSnippet(category: 'starters' | 'patterns', name: string): string {
  const bucket = SNIPPET_DATA[category] as Record<string, string>;
  const yaml = bucket[name];
  if (yaml === undefined) {
    throw new Error(`loadSnippet: unknown snippet '${category}/${name}'`);
  }
  return yaml;
}

export const SNIPPET_STARTERS = [
  'archon-feature-development',
  'archon-fix-github-issue',
  'archon-test-loop-dag',
] as const;

export const SNIPPET_PATTERNS = [
  'classify-then-branch',
  'fan-out-collect',
  'loop-until-signal',
] as const;

export type SnippetStarter = (typeof SNIPPET_STARTERS)[number];
export type SnippetPattern = (typeof SNIPPET_PATTERNS)[number];
