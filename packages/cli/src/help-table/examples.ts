import type { ExampleHelp } from './types';

// Hand-curated example order matching the pre-refactor Examples block. The
// original order is not a natural entry iteration — e.g. workflow run's
// `--adopt` example appears after workflow runs's `--open` example — so we
// keep the exact order here and filter by owner for scoped rendering.
export const orderedExamples: ExampleHelp[] = [
  { text: 'archon chat "What does the orchestrator do?"', owner: { command: 'chat' } },
  { text: 'archon workflow list', owner: { command: 'workflow', subcommand: 'list' } },
  {
    text: 'archon workflow run investigate-issue "Fix the login bug"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run plan --cwd /path/to/repo "Add dark mode"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run implement --branch feature-auth "Implement auth"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run quick-fix --no-worktree "Fix typo"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run investigate --folder "Explain how the repos under this root fit together"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run archon-investigate --detach "Investigate the flaky test"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run investigate --dry-run --stubs ./stubs.yaml --json',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  { text: 'archon workflow runs --json', owner: { command: 'workflow', subcommand: 'runs' } },
  {
    text: 'archon workflow get <run-id> --json',
    owner: { command: 'workflow', subcommand: 'get' },
  },
  {
    text: 'archon workflow artifacts <run-id> plan.md',
    owner: { command: 'workflow', subcommand: 'artifacts' },
  },
  { text: 'archon project list --json', owner: { command: 'project', subcommand: 'list' } },
  {
    text: 'archon workflow logs <run-id> --follow',
    owner: { command: 'workflow', subcommand: 'logs' },
  },
  {
    text: 'archon workflow logs <run-id> --follow --format text',
    owner: { command: 'workflow', subcommand: 'logs' },
  },
  {
    text: 'archon workflow wait <run-id> --json',
    owner: { command: 'workflow', subcommand: 'wait' },
  },
  { text: 'archon workflow resume <run-id>', owner: { command: 'workflow', subcommand: 'resume' } },
  { text: 'archon workflow cancel <run-id>', owner: { command: 'workflow', subcommand: 'cancel' } },
  { text: 'archon workflow runs --open', owner: { command: 'workflow', subcommand: 'runs' } },
  {
    text: 'archon workflow run archon-review --adopt <run-id> "Review the changes"',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  { text: 'archon skill add', owner: { command: 'skill', subcommand: 'add' } },
  {
    text: 'archon skill add /path/to/project',
    owner: { command: 'skill', subcommand: 'add' },
  },
  {
    text: 'archon plugin add coleam00/Archon/plugins/forge-github',
    owner: { command: 'plugin', subcommand: 'add' },
  },
];
