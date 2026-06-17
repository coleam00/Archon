/**
 * Tab summaries: single JSON contract for the canonical top-of-tab summary block.
 * Keep this in Jason's walk-through order so every tab answers:
 * what is this for, where are we, what is next, and what blocks motion.
 */

import type { TabSummaryStatus } from '@/components/TabSummary';

export interface TabSummaryEntry {
  /** Leading-slash react-router path */
  route: string;
  /** Display title */
  title: string;
  /** 1-sentence "what is this tab for" */
  purpose: string;
  /** Pill state */
  status: TabSummaryStatus;
  /** Current focus, one line */
  focus: string;
  /** Open blockers count */
  blockers: number;
  /** Last data refresh, ISO date or human-readable label */
  refreshed: string;
  /** Optional vault source shown in the footer */
  vaultPath?: string;
}

export const TAB_SUMMARIES: TabSummaryEntry[] = [
  {
    route: '/welcome',
    title: 'Start Here',
    purpose:
      'Executive landing page for Jason, Greg, partners, and the VA team to see the current command-center orientation.',
    status: 'live',
    focus: 'Start every walkthrough with priority, audience, and next-action context.',
    blockers: 0,
    refreshed: '2026-06-16',
    vaultPath: 'second-brain/Dashboard.md',
  },
  {
    route: '/pmc',
    title: 'PMC Command Center',
    purpose:
      'Primary revenue command surface for first meetings, practice-owner positioning, pipeline, and market proof.',
    status: 'live',
    focus: 'First meetings booked per week, with TTTS RSVP generation as equal near-term priority.',
    blockers: 0,
    refreshed: '2026-06-16',
    vaultPath: 'second-brain/businesses/pmc/overview.md',
  },
  {
    route: '/brt',
    title: 'BioReg / BRT',
    purpose:
      'Clinical-partner and device-education surface for BRT positioning, evidence, ICPs, and outreach readiness.',
    status: 'live',
    focus:
      'Trust-building content and Clinical Partner Program outreach without unsupported FDA claims.',
    blockers: 1,
    refreshed: '2026-06-16',
    vaultPath: 'second-brain/businesses/pmc/bioreg/overview.md',
  },
  {
    route: '/ttts',
    title: 'TTTS',
    purpose:
      'Therapeutic Technology Showcase execution surface for RSVP generation, sponsor context, and post-event conversion.',
    status: 'live',
    focus: 'Generate RSVPs while preserving relationship and content-capture strategy.',
    blockers: 1,
    refreshed: '2026-06-16',
    vaultPath: 'second-brain/businesses/pmc/ttts/overview.md',
  },
  {
    route: '/ewc',
    title: 'EWC / BioReg.tech',
    purpose:
      'Jason LLC surface for awareness, education, partner-payment context, and BioReg.tech Instagram planning.',
    status: 'building',
    focus: 'Map Instagram firehose content before heavier EWC catalog work.',
    blockers: 2,
    refreshed: '2026-06-16',
    vaultPath: 'second-brain/businesses/pmc/ewc/overview.md',
  },
  {
    route: '/ihht',
    title: 'IHHT',
    purpose:
      'Intermittent Hypoxia-Hyperoxia Therapy surface for sleep-apnea-relevant hooks, one-pagers, and partner context.',
    status: 'building',
    focus: 'One-pager is shipped; demo script and outbound sequence remain pending.',
    blockers: 2,
    refreshed: '2026-06-16',
    vaultPath: 'second-brain/businesses/pmc/iht/overview.md',
  },
  {
    route: '/fountain',
    title: 'Fountain / QEP',
    purpose:
      'Fountain-associated QEP view for health-data governance context and white-label boundary control.',
    status: 'building',
    focus: 'Keep QEP Fountain-only until Blake approves any white-label motion.',
    blockers: 2,
    refreshed: '2026-06-16',
    vaultPath: 'second-brain/businesses/pmc/qep/overview.md',
  },
  {
    route: '/accufit',
    title: 'AccuFit',
    purpose:
      'Partner and offer surface for AccuFit opportunity context, agreement status, and content/outreach planning.',
    status: 'building',
    focus: 'Hold direct outbound until agreement terms and role boundaries are clear.',
    blockers: 1,
    refreshed: '2026-06-16',
  },
  {
    route: '/external-reps/sadn',
    title: 'Sarasota Art & Dance Night',
    purpose:
      'External-rep sponsorship surface for SADN outreach, assets, replies, and send tracking.',
    status: 'live',
    focus: 'Sponsor follow-up and reply triage with locked media assets.',
    blockers: 0,
    refreshed: '2026-06-16',
    vaultPath: 'second-brain/businesses/external-reps/sadn',
  },
  {
    route: '/external-reps/arc',
    title: 'ARC',
    purpose: 'External-rep surface for ARC context, prospect motion, and handoff-ready messaging.',
    status: 'building',
    focus: 'Keep asset/context gaps visible before broad outreach.',
    blockers: 1,
    refreshed: '2026-06-16',
  },
  {
    route: '/solutions',
    title: 'Solutions Portfolio',
    purpose:
      'Partner-safe map of solutions, proof, priorities, and compliance boundaries across the portfolio.',
    status: 'live',
    focus: 'Keep labels truthful: Quicksilver, Fountain/QEP, EWC, BRT, IHT, Weave, Narrow Cloud.',
    blockers: 0,
    refreshed: '2026-06-16',
    vaultPath: 'second-brain/partners/',
  },
  {
    route: '/contacts',
    title: 'Contacts / Prospects',
    purpose:
      'Lead and relationship surface for who to contact, why they matter, and which lane they belong in.',
    status: 'live',
    focus: 'Support first meetings with better prioritization and clean ICP routing.',
    blockers: 0,
    refreshed: '2026-06-16',
    vaultPath: 'second-brain/contacts/prospects/',
  },
  {
    route: '/drive',
    title: 'Drive Assets',
    purpose:
      'Asset index for brand files, intake docs, training videos, decks, and field materials.',
    status: 'live',
    focus: 'Make new and changed Drive assets easy to triage into the vault.',
    blockers: 0,
    refreshed: 'hourly snapshot',
    vaultPath: 'second-brain/intelligence/drive-index/',
  },
  {
    route: '/research',
    title: 'Research Firehose',
    purpose:
      'Daily research synthesis for market signals, VA-ready hooks, ICP angles, and compliant content ideas.',
    status: 'live',
    focus: 'Remove Carlos branding, send daily to Andrew, and prepare VA-ready actions.',
    blockers: 1,
    refreshed: 'daily 9:15am ET',
    vaultPath: 'second-brain/intelligence/briefs/',
  },
  {
    route: '/social-content',
    title: 'Social Content',
    purpose:
      'LinkedIn and BioReg.tech content planning surface for converting firehose signal into trust-building posts.',
    status: 'building',
    focus: 'Make posts punctual, poignant, intelligent, simple, and visually refreshing.',
    blockers: 1,
    refreshed: '2026-06-16',
    vaultPath: 'second-brain/businesses/pmc/messaging/va-claude-project/',
  },
  {
    route: '/playground',
    title: 'Outbound Playground',
    purpose:
      'Live experimentation surface for dial outcomes, funnel diagnostics, sequences, and first-meeting mechanics.',
    status: 'live',
    focus: 'Use dial and reply data to decide the next best outreach action.',
    blockers: 0,
    refreshed: 'daily snapshot',
  },
  {
    route: '/agents',
    title: 'Daily Ops / Bots',
    purpose:
      'Digestible view of what Carlos, crons, traces, and workflow agents are doing each day.',
    status: 'live',
    focus: 'Show bot activity, source freshness, privacy guardrails, and next ops actions.',
    blockers: 0,
    refreshed: 'cron-emitted',
    vaultPath: 'second-brain/intelligence/carlos-state-snapshot.md',
  },
];

export function getTabSummary(route: string): TabSummaryEntry | undefined {
  return TAB_SUMMARIES.find(e => e.route === route);
}
