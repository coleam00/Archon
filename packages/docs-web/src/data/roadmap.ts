export type RoadmapStatus = 'shipped' | 'in-progress' | 'next' | 'planned';
export type RoadmapTier = 'primary' | 'secondary';

export interface RoadmapItem {
  slug: string;
  title: string;
  status: RoadmapStatus;
  tier?: RoadmapTier;
  version?: string;
  description: string;
  bullets: string[];
  tags: string[];
  issues?: number[];
}

export const statusConfig: Record<RoadmapStatus, { label: string; symbol: string; color: string; bg: string; border: string }> = {
  shipped:      { label: 'Shipped',      symbol: '✓', color: '#22c55e', bg: 'rgba(34,197,94,0.08)',   border: 'rgba(34,197,94,0.25)'   },
  'in-progress':{ label: 'In Progress',  symbol: '◐', color: '#f59e0b', bg: 'rgba(245,158,11,0.08)',  border: 'rgba(245,158,11,0.25)'  },
  next:         { label: 'Next',         symbol: '→', color: '#3b82f6', bg: 'rgba(59,130,246,0.08)',  border: 'rgba(59,130,246,0.25)'  },
  planned:      { label: 'Planned',      symbol: '◇', color: '#a855f7', bg: 'rgba(168,85,247,0.08)', border: 'rgba(168,85,247,0.25)'  },
};

export const roadmapItems: RoadmapItem[] = [
  {
    slug: 'core-cli',
    title: 'Core CLI & DAG Engine',
    status: 'shipped',
    version: 'v0.1',
    description: 'The foundation — YAML-defined workflows, DAG execution with dependency resolution, and git worktree isolation per run.',
    bullets: [
      'YAML workflow definition language',
      'DAG orchestration with full dependency resolution',
      'Git worktree isolation — no conflicts between runs',
      'Multi-provider support (Claude Code SDK, Codex SDK)',
    ],
    tags: ['core', 'cli', 'dag'],
  },
  {
    slug: 'adapters-deployment',
    title: 'Adapters & Deployment',
    status: 'shipped',
    version: 'v0.2',
    description: 'Trigger Archon workflows from any surface — Slack, Telegram, GitHub, Web UI, Discord — and deploy anywhere.',
    bullets: [
      'Official adapters: Slack, Telegram, GitHub, Web',
      'Community adapters: Discord, GitLab, Gitea',
      'Docker & cloud deployment guides',
      'Windows native support',
    ],
    tags: ['adapters', 'deployment', 'integrations'],
  },
  {
    slug: 'pi-provider',
    title: 'Pi Agent Provider',
    status: 'shipped',
    version: 'v0.3',
    description: 'Run Archon workflows with Pi — an open-source, multi-model coding agent. Breaks the Claude Code / Codex lock-in and opens Archon to GPT, Gemini, Qwen, DeepSeek, and more.',
    bullets: [
      'Pi coding agent as a first-class Archon provider',
      'Supports any model Pi runs on — GPT-5, Claude, Gemini 2.x, Qwen Coder, DeepSeek V3',
      'Optional access to Pi\'s ~540-package extension ecosystem',
      'Skills, structured output, session resume, and tool restrictions all supported',
    ],
    tags: ['providers', 'pi', 'multi-model'],
  },
  {
    slug: 'hooks-commands',
    title: 'Hooks, Commands & Quality Gates',
    status: 'shipped',
    version: 'v0.3',
    description: 'Fine-grained workflow control with hooks, reusable commands, loop nodes, approval gates, and script nodes.',
    bullets: [
      'Pre/post hooks on any workflow node',
      'Reusable commands library (share logic across workflows)',
      'Loop nodes with configurable iterations',
      'Approval nodes for human-in-the-loop checkpoints',
      'Script nodes for custom automation logic',
    ],
    tags: ['hooks', 'commands', 'quality'],
  },
  {
    slug: 'streamlined-setup',
    title: 'Streamlined Setup & Binary Install',
    status: 'in-progress',
    version: 'v0.4',
    description: 'Getting started with Archon should take under 5 minutes. A fully self-contained binary, one-line installers, and a first-run wizard that auto-detects your AI provider.',
    bullets: [
      'Fully self-contained binary distribution (no Node/Bun required)',
      'One-line install: curl/irm scripts for macOS, Linux, Windows',
      'Homebrew formula',
      'Interactive first-run setup wizard',
      'Auto-detection of Claude and Codex credentials',
    ],
    tags: ['dx', 'install', 'onboarding'],
  },
  {
    slug: 'workflow-marketplace',
    title: 'Workflow Marketplace',
    status: 'next',
    version: 'v0.5',
    description: 'An open source registry for community-built Archon workflows. Browse, install, and share workflows in one place.',
    bullets: [
      'archon.diy/workflows — searchable, filterable directory',
      'WORKFLOW.md spec — standard format for shareable workflows',
      'One-command install: archon workflow install <slug>',
      'Category filtering, tag search, and author pages',
      'PR-based submission — curated, no backend required',
    ],
    tags: ['community', 'marketplace', 'oss'],
  },
  {
    slug: 'eval-system',
    title: 'Eval System',
    status: 'planned',
    version: 'v0.6',
    description: 'A built-in evaluation framework to measure and improve workflow quality — test cases, correctness scoring, and reliability testing.',
    bullets: [
      'WORKFLOW.eval.yaml — define test inputs and expected outputs inline',
      'Step-level and output-level correctness scoring',
      'Reliability testing across multiple runs',
      'Eval score badges on marketplace listings',
      'archon workflow eval <name> — run evals from the CLI',
    ],
    tags: ['quality', 'testing', 'evals'],
  },
  {
    slug: 'workflow-control-flow',
    title: 'Advanced Workflow Control Flow',
    status: 'planned',
    description: 'Make workflows expressive enough for real test/fix and approval-driven automation — multi-node loop bodies, branching on approvals, and a real expression evaluator.',
    bullets: [
      'Multi-node loop bodies (compose plan → implement → validate per iteration)',
      'Conditional branching on approval and reject outcomes',
      'Semantic completion signals — agents finish when done, not by token-matching',
      'Real expression evaluator powering when:, loop_until:, and condition: clauses',
    ],
    tags: ['workflows', 'control-flow'],
    issues: [972, 1238, 1333, 1292, 1219, 1208, 1336, 1471, 1391, 1520],
  },
  {
    slug: 'persistent-orchestrator',
    title: 'Persistent Project Orchestrator',
    status: 'planned',
    description: 'One stateful conversation per codebase that retains context across runs, with project-first navigation and observable subagent activity.',
    bullets: [
      'Persistent orchestrator session bound to each project',
      'Project memory carried across runs and restarts',
      'Projects-first navigation in the Web UI',
      'Live SDK lifecycle events (subagent + hook activity) streamed to the UI',
    ],
    tags: ['orchestrator', 'web', 'memory'],
    issues: [968, 1044, 1038, 1058, 1205, 1179, 1182, 975],
  },
  {
    slug: 'local-llm-support',
    title: 'Local LLM Support',
    status: 'planned',
    description: 'Connect Archon to local inference servers and OpenAI-compatible API proxies — bring your own model.',
    bullets: [
      'OpenAI-compatible baseURL configuration',
      'Runtime workflow variables for dispatch-time model selection',
      'Bundled workflows respect DEFAULT_AI_ASSISTANT instead of locking a provider',
    ],
    tags: ['providers', 'local', 'multi-model'],
    issues: [1334, 1127, 1449],
  },
  {
    slug: 'workflow-reliability',
    title: 'Workflow Execution Reliability',
    status: 'planned',
    description: 'Eliminate silent-success failure modes — workflows must never report completion while shipping nothing.',
    bullets: [
      'Audit and harden every workflow resumption and cache path',
      'Defensive handling of provider error patterns (Codex turn.failed, Claude stop-sequence success)',
      'Invariant checks before state restore — refuse to auto-resume failed runs into fresh requests',
    ],
    tags: ['reliability', 'workflows'],
    issues: [1549, 1516, 1471, 1425, 1546, 1531, 1378, 1208, 1520],
  },
  {
    slug: 'multi-model-providers',
    title: 'Additional Model Providers',
    status: 'planned',
    tier: 'secondary',
    description: 'Pluggable provider SDKs beyond Claude and Codex — Copilot, Hermes — plus per-dispatch model selection.',
    bullets: [],
    tags: ['providers'],
    issues: [1115, 1106, 1127, 1433],
  },
  {
    slug: 'multi-repo-workspaces',
    title: 'Multi-Repo Workspace Support',
    status: 'planned',
    tier: 'secondary',
    description: 'Multiple clones of the same remote as distinct projects, branch-aware sync, and unambiguous webhook routing.',
    bullets: [],
    tags: ['isolation', 'git'],
    issues: [1273, 1192, 1289, 1319, 1347, 1281, 1516],
  },
  {
    slug: 'enterprise-github-auth',
    title: 'Enterprise GitHub Auth',
    status: 'planned',
    tier: 'secondary',
    description: 'GitHub App with per-installation tokens and secure secret resolution for org and team setups.',
    bullets: [],
    tags: ['auth', 'enterprise'],
    issues: [1495, 1467, 1469, 1476, 1385],
  },
  {
    slug: 'production-deployment',
    title: 'Production-Ready Deployment',
    status: 'planned',
    tier: 'secondary',
    description: 'Reliable Docker, Pi and VPS support, Cloudflare Tunnel, hardened Windows execution.',
    bullets: [],
    tags: ['deployment', 'docker'],
    issues: [1170, 1237, 1452, 1174, 1168, 1326, 1290],
  },
];
