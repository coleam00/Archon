#!/usr/bin/env python3
"""Build per-business top-prospects JSON for the Archon BusinessPage tabs.

Aggregates engaged contacts from Apollo (~/.hermes/cache/apollo-engaged-contacts.json,
produced by the ad-hoc engaged-contacts pull or daily refresh) and groups them by
business line. Each business tab consumes its own slice for the "Top Prospects" section.

Output: packages/web/src/lib/business-prospects.generated.json

Contract:
  {
    "generated_at": "ISO-8601",
    "source": "Apollo /v1/contacts/search filtered q_emailer_message_replied=true",
    "by_business": {
      "BRT": [{name, title, company, email, phone, linkedin_url, channel, source_campaign, ...}],
      "PMC": [...],
      "EWC": [...],
      "Fountain": [...],
      "QEP": [...],
      "SADN": [...],   <- from Susan's outreach prospect list, NOT Apollo
    }
  }
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ARCHON_ROOT = SCRIPT_DIR.parent
JID_ROOT = ARCHON_ROOT.parent
VAULT = JID_ROOT / "second-brain"
HERMES_CACHE = Path.home() / ".hermes" / "cache"

ENGAGED_CONTACTS = HERMES_CACHE / "apollo-engaged-contacts.json"
OUT_PATH = ARCHON_ROOT / "packages" / "web" / "src" / "lib" / "business-prospects.generated.json"

# Campaign-to-business mapping (matches Playground brand detection)
CAMPAIGN_TO_BUSINESS = {
    "Behavioral Health Sequence -- Therapy": "BRT",
    "Behavioral Health Sequence -- Psychiatric": "BRT",
    "Medspa Sequence 1": "BRT",
    "Chiro Sequence -- BRT/PMC(SOMA)": "BRT",  # Dual-brand, but BRT-primary
    "US PMC ICP Verified Only": "PMC",
    "US PMC ICP Verfied Only": "PMC",  # Apollo's actual stored name (typo)
}

# SADN — Susan Szantosi outreach prospects, distilled from:
# drafts/2026-05-20-sarasota-art-dance-sponsor-email-templates.md
# These are Susan's warm-and-cold sponsor target list.
SADN_PROSPECTS = [
    # Tier 1 — Warm Connection (Template 1, prior relationship)
    {"name": "Flow Massage & Wellness", "tier": "Warm", "category": "Wellness studio",
     "channel": "email", "ask": "$300-1500 sponsor", "notes": "Women-founder wellness model"},
    {"name": "Dr. Medge Jaspan", "tier": "Warm", "category": "Practice",
     "channel": "email", "ask": "$300-1500 sponsor"},
    {"name": "LUX MedSpa", "tier": "Warm", "category": "Medspa",
     "channel": "email", "ask": "$1500 Signature Showcase",
     "notes": "Premium aesthetic experience aligns w/ showcase"},
    {"name": "Precision Health & Aesthetics", "tier": "Warm", "category": "Aesthetics",
     "channel": "email", "ask": "$1500 Signature Showcase",
     "notes": "Existing Jason client relationship"},
    {"name": "Coral & Reef", "tier": "Warm", "category": "Lifestyle/Hospitality",
     "channel": "email", "ask": "$300-1500"},
    {"name": "Beem Light", "tier": "Warm", "category": "Wellness",
     "channel": "email", "ask": "$300-1500"},
    {"name": "Alvarado Hypnotherapy", "tier": "Warm", "category": "Mind-body",
     "channel": "email", "ask": "$300-1500"},
    {"name": "Visiting Angels", "tier": "Warm", "category": "Healthcare svcs",
     "channel": "email", "ask": "$300-1500"},
    {"name": "Reveal Vitality", "tier": "Warm", "category": "Functional/integrative med",
     "channel": "email", "ask": "$1500 Signature Showcase",
     "notes": "Integrative-medicine philosophy fits showcase"},
    {"name": "Valley Bank", "tier": "Warm", "category": "Bank",
     "channel": "email", "ask": "$1500 Signature Showcase",
     "notes": "Local bank brand-elevated play"},
    {"name": "Dr. Jones Lakewood Ranch", "tier": "Warm", "category": "Practice",
     "channel": "email", "ask": "$300-1500"},
    {"name": "Sarasota Personal Medicine", "tier": "Warm", "category": "Concierge med",
     "channel": "email", "ask": "$1500 Signature Showcase"},
    {"name": "LernerCohen", "tier": "Warm", "category": "Healthcare",
     "channel": "email", "ask": "$1500 Signature Showcase"},
    {"name": "Sarasota Facial Aesthetics", "tier": "Warm", "category": "Aesthetics",
     "channel": "email", "ask": "$1500 Signature Showcase"},
]

# Fountain WPB / QEP key prospects + audience pull-through (Blake Baynham is captured
# in the Fountain WPB overview file; this surfaces him for the tab)
FOUNTAIN_PROSPECTS = [
    {"name": "Blake Baynham", "tier": "Key Contact", "category": "The Fountain leadership",
     "channel": "direct", "notes": "Confirmed key contact 2026-06-03; intake pending for title/email/phone",
     "company": "The Fountain (WPB)"},
    {"name": "QEP executive audience", "tier": "Audience",
     "category": "Quantum Executive Protocol patrons",
     "channel": "in-person at venue",
     "notes": "Luxury wellness / longevity buyer profile — BRT + Cellcom demo target"},
]


def build():
    if not ENGAGED_CONTACTS.exists():
        print(f"[business-prospects] WARN: {ENGAGED_CONTACTS} missing — Apollo block empty",
              file=sys.stderr)
        apollo_data = {"contacts": []}
    else:
        apollo_data = json.loads(ENGAGED_CONTACTS.read_text())

    by_business: dict[str, list[dict]] = defaultdict(list)

    # Apollo contacts
    for c in apollo_data.get("contacts", []):
        biz = CAMPAIGN_TO_BUSINESS.get(c.get("campaign_name", ""), "Other")
        if not c.get("email") and not c.get("phone") and not c.get("linkedin_url"):
            continue  # skip records with no contact info
        by_business[biz].append({
            "name": c.get("name") or "(unnamed)",
            "title": c.get("title"),
            "company": c.get("company"),
            "email": c.get("email"),
            "phone": c.get("phone"),
            "linkedin_url": c.get("linkedin_url"),
            "channel": "Apollo email reply",
            "source_campaign": c.get("campaign_name"),
            "apollo_id": c.get("apollo_id"),
            "engagement": "Replied (Apollo)",
            "tier": "Warm",
        })

    # Sort each Apollo bucket: contacts with full contact info first
    for biz, items in by_business.items():
        items.sort(
            key=lambda c: (
                0 if c.get("email") else 1,
                0 if c.get("phone") else 1,
                0 if c.get("linkedin_url") else 1,
                0 if c.get("company") else 1,
                (c.get("name") or "").lower(),
            )
        )
        # Cap at 20 per business for dashboard
        by_business[biz] = items[:20]

    # SADN curated list
    by_business["SADN"] = [
        {**p, "engagement": "Susan-curated sponsor target", "source_campaign": "Sarasota Art & Dance Night Nov 15 2026"}
        for p in SADN_PROSPECTS
    ]

    # Fountain WPB / QEP
    by_business["Fountain"] = [
        {**p, "engagement": "Core client", "source_campaign": "Fountain WPB direct engagement"}
        for p in FOUNTAIN_PROSPECTS
    ]
    by_business["QEP"] = [
        {"name": "The Fountain (WPB venue)", "tier": "Anchor venue",
         "category": "Luxury wellness / longevity",
         "channel": "in-person", "engagement": "QEP partner venue",
         "source_campaign": "QEP partnership"},
        {"name": "Blake Baynham (The Fountain)", "tier": "Key contact",
         "category": "Cross-brand decision-maker", "channel": "direct",
         "engagement": "Core client liaison", "source_campaign": "Fountain WPB"},
    ]

    # AccuFit
    by_business["AccuFit"] = [
        {"name": "Lutronic territory rep", "tier": "Pending intake",
         "category": "Distributor opp", "channel": "direct",
         "engagement": "Exploring partnership", "source_campaign": "AccuFit distributorship",
         "notes": "Need rep contact; Showpad asset link captured"},
        {"name": "Existing BRT medspa clients", "tier": "Cross-sell warm",
         "category": "Co-placement targets", "channel": "warm intro",
         "engagement": "BRT + AccuFit stack opportunity",
         "source_campaign": "AccuFit cross-sell to BRT base",
         "notes": "Medspas + luxury gyms — same ICP as BRT"},
    ]

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_apollo": str(ENGAGED_CONTACTS) if ENGAGED_CONTACTS.exists() else None,
        "totals": {biz: len(items) for biz, items in by_business.items()},
        "by_business": dict(by_business),
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2))
    print(f"[business-prospects] Wrote prospects for {len(by_business)} businesses -> "
          f"{OUT_PATH.relative_to(JID_ROOT)}")
    for biz, items in by_business.items():
        print(f"  {biz}: {len(items)}")


if __name__ == "__main__":
    build()
