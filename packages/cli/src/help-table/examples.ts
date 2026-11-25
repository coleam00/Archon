import type { ExampleHelp } from './types';

// Hand-curated example order matching the pre-refactor Examples block. The
// original order is not a natural entry iteration — e.g. workflow run's
// `--adopt` example appears after workflow runs's `--open` example — so we
// keep the exact order here and filter by owner for scoped rendering.
export const orderedExamples: ExampleHelp[] = [
  { text: 'archon chat "What does the orchestrator do?"', owner: { command: 'chat' } },
  { text: 'archon workflow list', owner: { command: 'workflow', subcommand: 'list' } },
  {
    text: 'archon workflow run archon-triage --item issue-42 --input issue=42',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run archon-plan --cwd /path/to/repo --item issue-42 --input issue=42',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run archon-land --item issue-42 --input issue=42 --branch feature-auth',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run archon-investigate --no-worktree --item issue-42 --input issue=42',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run archon-investigate --folder --item issue-42 --input issue=42',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run archon-triage --item issue-42 --input issue=42 --detach',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: 'archon workflow run archon-investigate --item issue-42 --input issue=42 --dry-run --stubs ./stubs.yaml --json',
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
  { text: 'archon project add --json', owner: { command: 'project', subcommand: 'add' } },
  {
    text: 'archon project config <id|name> --json',
    owner: { command: 'project', subcommand: 'config' },
  },
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
  { text: 'archon workflow pause <run-id>', owner: { command: 'workflow', subcommand: 'pause' } },
  { text: 'archon workflow resume <run-id>', owner: { command: 'workflow', subcommand: 'resume' } },
  { text: 'archon workflow cancel <run-id>', owner: { command: 'workflow', subcommand: 'cancel' } },
  {
    text: 'archon workflow cancel --item issue-42',
    owner: { command: 'workflow', subcommand: 'cancel' },
  },
  { text: 'archon workflow runs --open', owner: { command: 'workflow', subcommand: 'runs' } },
  {
    text: 'archon workflow run archon-review --adopt <run-id>',
    owner: { command: 'workflow', subcommand: 'run' },
  },
  {
    text: "archon forge <operation> --help    # that operation's request fields and an example",
    owner: { command: 'forge' },
  },
  { text: 'archon skill add', owner: { command: 'skill', subcommand: 'add' } },
  {
    text: 'archon skill add /path/to/project',
    owner: { command: 'skill', subcommand: 'add' },
  },
  {
    text: 'archon skill add --pack owner/repo',
    owner: { command: 'skill', subcommand: 'add' },
  },
  {
    text: 'archon plugin add coleam00/Archon/plugins/forge-github',
    owner: { command: 'plugin', subcommand: 'add' },
  },
];
