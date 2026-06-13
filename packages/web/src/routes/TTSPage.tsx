import overviewRaw from '@second-brain/businesses/pmc/ttts/overview.md?raw';
import { BusinessPage } from '@/components/business/BusinessPage';

const VAULT_PATH = 'second-brain/businesses/pmc/ttts/overview.md';

const SECTIONS = [
  {
    heading: 'June 27 closed-door session',
    items: [
      {
        slug: 'format',
        title: '12-founder session',
        description: 'Closed-door, invitation-only · Sarasota, FL',
        badge: 'event',
        badgeTone: 'sky' as const,
      },
      {
        slug: 'goal',
        title: 'Outcome target',
        description: '8 of 12 founders book follow-up by July 11',
      },
      {
        slug: 'role',
        title: 'BD asset',
        description: 'Feeds Lines #1-2 (BRT BH, Chiro/Medspa). Not the engagement timeline driver.',
      },
    ],
  },
  {
    heading: 'Adjacent ICPs',
    items: [
      {
        slug: 'organizers',
        title: 'Healthcare conference organizers',
        description: 'Cross-event partnership opportunities',
      },
      {
        slug: 'influencers',
        title: 'Wellness influencers with clinical credibility',
        description: 'Founder-network referral path',
      },
      {
        slug: 'device-categories',
        title: 'Adjacent device categories',
        description: 'Red light, hyperbaric, cold plunge',
      },
    ],
  },
  {
    heading: 'Sub-pages in vault',
    items: [
      {
        slug: 'rsvp-tracker',
        title: 'RSVP & qualification tracker',
        description: 'rsvp-tracker.md — live funnel vs 40-attendee target',
        badge: 'live',
        badgeTone: 'emerald' as const,
      },
      {
        slug: 'phase-3-launch-decisions',
        title: 'Phase 3 launch decisions',
        description: 'phase-3-launch-decisions.md — 4 decisions pending Jason ratification',
        badge: 'decide',
        badgeTone: 'amber' as const,
      },
      {
        slug: 'phase-3-fallback-execution-paths',
        title: 'Phase 3 fallback execution paths',
        description:
          'phase-3-fallback-execution-paths.md — pre-built pivots if 4-decision stack stalls past 6/12',
        badge: 'fallback',
        badgeTone: 'amber' as const,
      },
      {
        slug: 'phase-3-week-9-content-pack',
        title: 'Phase 3 Week 9 content pack (Jun 15-21)',
        description:
          'phase-3-week-9-content-pack.md — 7 hard-CTA pieces across IG/LI/FB, ships on Decision 1 ratification',
        badge: 'pending',
        badgeTone: 'amber' as const,
      },
      {
        slug: 'qualification-call-script',
        title: '15-min qualification call script',
        description: 'qualification-call-script.md — NEPQ-style soft-discovery + rubric',
      },
      {
        slug: 'calendly-event-spec',
        title: 'Calendly event spec',
        description:
          'calendly-event-spec.md — full TTTS qualification event-type provisioning blueprint',
        badge: 'spec',
        badgeTone: 'sky' as const,
      },
      {
        slug: 'collaborator-co-post-ask-templates',
        title: 'Collaborator co-post DM templates',
        description:
          'collaborator-co-post-ask-templates.md — 3 personalized DMs for the 4-5 collaborator gap-fill',
        badge: 'draft',
        badgeTone: 'sky' as const,
      },
      {
        slug: 'content-roadmap',
        title: 'Content roadmap',
        description: 'content-roadmap.md — 10-week TTTS content plan',
      },
    ],
  },
];

const KPIS = [
  { label: 'Event date', value: 'Jun 27, 2026' },
  { label: 'Format', value: '12 founders' },
  { label: 'Composite rank', value: 'Priority #6' },
  { label: 'Follow-up target', value: '8/12 by 7/11' },
];

export function TTSPage(): React.ReactElement {
  return (
    <BusinessPage
      overviewRaw={overviewRaw}
      fallbackName="TTTS — Therapeutic Technology Showcase"
      statusText="Active · BD asset"
      statusTone="sky"
      kpis={KPIS}
      sections={SECTIONS}
      vaultPath={VAULT_PATH}
    />
  );
}
