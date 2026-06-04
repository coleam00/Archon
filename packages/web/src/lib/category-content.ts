// Category content for the 4 operational categories.
// Per consultant review (2026-05-07) and Telegram session 2026-05-09, the dashboard
// surfaces work in 4 lenses (Writing & Comms, Research & Learning, Techbase, Work — Daily Ops)
// in addition to the per-brand pages.
//
// Each category lists:
//   - description (one-liner)
//   - vault sections (where the source-of-truth markdown lives)
//   - workflow IDs (from second-brain/workflows/workflow-catalog.json)
//   - quick links (most-used pages within the category)

export type CategorySlug = 'writing-comms' | 'research-learning' | 'techbase' | 'work-daily-ops';

export interface CategoryDef {
  slug: CategorySlug;
  label: string;
  shortLabel: string;
  emoji: string;
  oneLiner: string;
  description: string;
  vaultSections: { label: string; path: string }[];
  workflows: string[]; // WF-NNN ids
  quickLinks: { label: string; href: string; external?: boolean }[];
}

export const CATEGORIES: CategoryDef[] = [
  {
    slug: 'writing-comms',
    label: 'Writing & Comms',
    shortLabel: 'Writing',
    emoji: '✍️',
    oneLiner:
      'Email, Apollo sequences, HeyReach, LinkedIn, voice notes, brand voice, NEPQ scripts.',
    description:
      'All outbound copy and live messaging campaigns. Brand voice rules, NEPQ phone scripts, ' +
      'LinkedIn voice-note campaigns, Apollo cold sequences, HeyReach cadences, drafts queue. ' +
      'Anything that goes out the door for a prospect, partner, or audience touches this category.',
    vaultSections: [
      { label: 'PMC messaging', path: 'businesses/pmc/messaging/' },
      { label: 'Brand voice', path: 'resources/brand/_brand-voice.md' },
      { label: 'Editorial thesis', path: 'resources/brand/_editorial-thesis.md' },
      { label: 'Content compliance', path: 'resources/brand/_content-compliance.md' },
      { label: 'Frameworks index', path: 'frameworks/canonical-reference.md' },
      { label: 'Drafts (active)', path: 'drafts/' },
    ],
    workflows: [
      'WF-002', // TTTS Content Batch Scheduler
      'WF-003', // PMC Apollo Cold Sequence Runner
      'WF-004', // BRT Apollo Cold Sequence Runner
      'WF-006', // LinkedIn Sarasota Outreach
      'WF-007', // Instagram Practitioner DMs
      'WF-013', // PMC Discovery Call Prep Brief
      'WF-015', // Content Repurposer
      'WF-016', // Portfolio Content Calendar
      'WF-021', // Brand Guardrail Linter
      'WF-024', // PMC Weekly Authority Digest
    ],
    quickLinks: [
      { label: 'PMC tab', href: '/pmc' },
      { label: 'BRT tab', href: '/brt' },
      { label: 'VA Workspace', href: '/social-content' },
    ],
  },
  {
    slug: 'research-learning',
    label: 'Research & Learning',
    shortLabel: 'Research',
    emoji: '🔬',
    oneLiner: 'Healthcare/medtech landscape monitoring + competitive intel + research briefs.',
    description:
      'Staying current on healthcare, medtech, and insurance trends. Tracks comparable players ' +
      '(SignatureMD, Griffin Concierge, MDVIP), modality science (BRT/Cellcom, Naba, Cell-IT, ' +
      'VivaFuel), and produces research briefs that feed Writing & Comms. Future home for the ' +
      'content-architect + investigative-journalist subagents (spec pending).',
    vaultSections: [
      { label: 'Research MOC', path: 'research/_research.md' },
      { label: 'Sources taxonomy', path: 'research/sources.md' },
      { label: 'Briefs', path: 'research/briefs/' },
      { label: 'Knowledge concepts', path: 'knowledge/concepts/' },
      { label: 'Knowledge entities', path: 'knowledge/entities/' },
      { label: 'Engagement timeline', path: 'intelligence/_ENGAGEMENT_TIMELINE.md' },
    ],
    workflows: [
      'WF-017', // Prospect Enrichment + ICP Scorer
      'WF-022', // Not-Yet-Fit Re-engagement Queue
    ],
    quickLinks: [
      { label: 'IHHT tab (modality)', href: '/ihht' },
      { label: 'NABA tab (modality)', href: '/naba' },
      { label: 'QEP tab (modality)', href: '/qep' },
    ],
  },
  {
    slug: 'techbase',
    label: 'Techbase',
    shortLabel: 'Techbase',
    emoji: '⚙️',
    oneLiner:
      'Infrastructure: agent runtime, automation rails, CRM, webhooks, vault sync, secrets.',
    description:
      'How the system actually runs. Agent runtimes (Carlos, Hermes), launchd/cron jobs, ' +
      'browser automation, CRM integrations (Apollo, HeyReach, Linear), webhooks, vault sync, ' +
      'hosting (Mac Mini, DigitalOcean), secret stores (Bitwarden, AWS SM). The ' +
      'workflow-status detector reports its weekly sweep here.',
    vaultSections: [
      { label: 'Workflow catalog', path: 'workflows/workflow-catalog.md' },
      { label: 'Workflow status reports', path: 'reports/' },
      {
        label: 'Apollo wiring spec',
        path: 'projects/internal-projects/integration-roadmap/apollo-wiring-spec.md',
      },
      {
        label: 'Gmail OAuth spec',
        path: 'projects/internal-projects/integration-roadmap/gmail-oauth-spec.md',
      },
      {
        label: 'WF-001 morning brief diag',
        path: 'projects/internal-projects/integration-roadmap/wf-001-morning-brief-diagnosis.md',
      },
      {
        label: 'Integration roadmap MOC',
        path: 'projects/internal-projects/integration-roadmap/README.md',
      },
      { label: 'Coding projects', path: 'projects/coding-projects/' },
      { label: 'ADRs', path: 'intelligence/decisions/' },
    ],
    workflows: [
      'WF-005', // Dual-Brand Suppression Guard
      'WF-009', // Pipeline Stage Tracker
      'WF-014', // "That's Right" Label Tracker
      'WF-020', // Gmail Reply Triage
      'WF-023', // TTTS Asset Library Sync
    ],
    quickLinks: [
      { label: 'Workflows page', href: '/workflows' },
      { label: 'Settings', href: '/settings' },
    ],
  },
  {
    slug: 'work-daily-ops',
    label: 'Work — Daily Ops',
    shortLabel: 'Daily Ops',
    emoji: '📋',
    oneLiner: 'Tasks, calendar, inbox, VA coordination, briefings, decisions, operating cadence.',
    description:
      'The day-to-day operating layer. This-week tasks, blockers, backlog, calendar, inbox ' +
      'triage, VA team coordination (Louise, James, Trisha, Vincent, Ed), morning briefings, ' +
      'decision queue. Where the team picks up "what to do today" — and where Carlos surfaces ' +
      'suggestions for Jason + Louise to triage.',
    vaultSections: [
      { label: 'This week', path: 'tasks/this-week.md' },
      { label: 'Blockers', path: 'tasks/blockers.md' },
      { label: 'Backlog', path: 'tasks/backlog.md' },
      { label: 'Daily logs', path: 'daily/' },
      { label: 'VA workstream MOC', path: 'projects/va-workstream/_va-workstream.md' },
      { label: 'VA queue inbound', path: 'projects/va-workstream/queue-inbound/' },
      { label: 'VA queue outbound', path: 'projects/va-workstream/queue-outbound/' },
      { label: 'VA SOPs', path: 'projects/va-workstream/sops/' },
      { label: 'Team registry', path: 'contacts/team/_team.md' },
      { label: 'Reports (weekly status)', path: 'reports/' },
    ],
    workflows: [
      'WF-001', // Morning Brief
      'WF-008', // TTTS Qualification Call Scheduler
      'WF-010', // Weekly KPI Dashboard
      'WF-011', // TTTS Countdown Cadence
      'WF-012', // Post-TTTS NEPQ Audit Capture
      'WF-018', // Collaborator Co-Post Tracker
      'WF-019', // VA Task Distributor
    ],
    quickLinks: [
      { label: 'Dashboard', href: '/dashboard' },
      { label: 'Chat with Carlos', href: '/chat' },
    ],
  },
];

export function getCategory(slug: CategorySlug): CategoryDef {
  const c = CATEGORIES.find(c => c.slug === slug);
  if (!c) {
    throw new Error(`Unknown category slug: ${slug as string}`);
  }
  return c;
}
