#!/usr/bin/env python3
"""Build Playground tab JSON from real data sources.

Aggregates:
  - Apollo dial list CSV (sequence-level counts + status)
  - Dial tracker history (per-call outcomes + timestamps)
  - Calendly bookings (when wired) — placeholder for now

Output: packages/web/src/lib/playground.generated.json

Contract (stable — React route depends on this shape):
  {
    "generated_at": "ISO-8601",
    "kpis": { meetings_this_week, dials_last_7d, active_sequences, reply_rate_14d },
    "sequences": [{slug, brand, contacts, replied, reply_rate, status}],
    "dials_by_day": [{date, outcome, count}],
    "outcome_funnel": [{stage, count}],
    "meetings_by_week": [{week, total, by_line: {...}}]
  }

When called with --check, prints the shape and exits.
"""

from __future__ import annotations

import csv
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

# --- Path resolution ---
SCRIPT_DIR = Path(__file__).resolve().parent
ARCHON_ROOT = SCRIPT_DIR.parent          # archon/
JID_ROOT = ARCHON_ROOT.parent             # jid5274/
VAULT = JID_ROOT / "second-brain"
HERMES_STATE = Path.home() / ".hermes" / "state"

APOLLO_CSV = VAULT / "intelligence" / "briefs" / "2026-05-13-apollo-dial-list-all.csv"
DIAL_HISTORY = HERMES_STATE / "dial_tracker_history.json"
DIAL_QUEUES_DIR = VAULT / "intelligence" / "briefs"  # YYYY-MM-DD-dial-queue.json files live here

OUT_PATH = ARCHON_ROOT / "packages" / "web" / "src" / "lib" / "playground.generated.json"

# --- Brand mapping ---
BRAND_BY_SEQUENCE_PREFIX = {
    "BH_": "BRT",
    "CHIRO": "BRT",
    "MEDSPA": "BRT",
    "PMC": "PMC",
    "EWC": "EWC",
    "LUMNEN": "EWC",
    "TTTS": "TTTS",
    "QEP": "QEP",
    "IHHT": "IHHT",
    "SGINK": "SG INK",
}

OUTCOME_FUNNEL_ORDER = [
    "total-dials",
    "connected",
    "conversation",
    "follow-up",
    "meeting-booked",
]

# Map raw outcomes to funnel stages
OUTCOME_TO_STAGE = {
    "no-answer": "total-dials",
    "voicemail": "total-dials",
    "gatekeeper": "connected",
    "wrong-number": "total-dials",
    "not-interested": "connected",
    "follow-up": "follow-up",
    "interested": "conversation",
    "meeting-booked": "meeting-booked",
    "closed-deal": "meeting-booked",
    "closed-test": "total-dials",  # test entries shouldn't count up the funnel
}


def detect_brand(sequence: str) -> str:
    seq_upper = (sequence or "").upper()
    for prefix, brand in BRAND_BY_SEQUENCE_PREFIX.items():
        if seq_upper.startswith(prefix):
            return brand
    return "Unassigned"


def build_sequences() -> list[dict]:
    """Aggregate Apollo dial list CSV by sequence: contacts + status."""
    if not APOLLO_CSV.exists():
        return []
    by_seq: dict[str, dict] = defaultdict(lambda: {"contacts": 0, "active": 0, "paused": 0})
    with APOLLO_CSV.open(encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            seq = (row.get("sequence") or "").strip()
            if not seq:
                continue
            status = (row.get("sequence_status") or "").strip().lower()
            by_seq[seq]["contacts"] += 1
            if status == "active":
                by_seq[seq]["active"] += 1
            elif status == "paused":
                by_seq[seq]["paused"] += 1

    out = []
    for seq, agg in sorted(by_seq.items(), key=lambda kv: -kv[1]["contacts"]):
        out.append({
            "slug": seq.lower().replace("_", "-"),
            "name": seq,
            "brand": detect_brand(seq),
            "contacts": agg["contacts"],
            "active": agg["active"],
            "paused": agg["paused"],
            # Reply rate placeholder — wire to apollo-daily-performance output in Phase 2
            "replied": 0,
            "reply_rate": 0.0,
            "status": "active" if agg["active"] > 0 else "paused",
        })
    return out


def build_dials_by_day(days: int = 30) -> list[dict]:
    """Aggregate dial_tracker_history.json into per-day outcome counts."""
    if not DIAL_HISTORY.exists():
        return []
    with DIAL_HISTORY.open(encoding="utf-8") as f:
        history = json.load(f)
    if not isinstance(history, dict):
        return []
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    by_day: dict[str, Counter] = defaultdict(Counter)
    for _key, entry in history.items():
        ts = entry.get("timestamp")
        outcome = entry.get("outcome")
        if not ts or not outcome:
            continue
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            continue
        if dt < cutoff:
            continue
        by_day[dt.date().isoformat()][outcome] += 1

    out = []
    for date_str in sorted(by_day):
        for outcome, count in by_day[date_str].items():
            out.append({"date": date_str, "outcome": outcome, "count": count})
    return out


def build_outcome_funnel() -> list[dict]:
    """Aggregate dial history into funnel-stage counts."""
    if not DIAL_HISTORY.exists():
        return [{"stage": s, "count": 0} for s in OUTCOME_FUNNEL_ORDER]
    with DIAL_HISTORY.open(encoding="utf-8") as f:
        history = json.load(f)
    stage_counts: Counter = Counter()
    stage_counts["total-dials"] = len(history)
    for entry in history.values():
        outcome = entry.get("outcome", "")
        # Cumulative stage assignment: any meeting-booked dial counts at every
        # earlier stage too, since the funnel is "got past this point or not."
        stage = OUTCOME_TO_STAGE.get(outcome)
        if stage == "meeting-booked":
            stage_counts["meeting-booked"] += 1
            stage_counts["follow-up"] += 1
            stage_counts["conversation"] += 1
            stage_counts["connected"] += 1
        elif stage == "follow-up":
            stage_counts["follow-up"] += 1
            stage_counts["conversation"] += 1
            stage_counts["connected"] += 1
        elif stage == "conversation":
            stage_counts["conversation"] += 1
            stage_counts["connected"] += 1
        elif stage == "connected":
            stage_counts["connected"] += 1
        # total-dials already counted via len(history)

    return [{"stage": s, "count": stage_counts[s]} for s in OUTCOME_FUNNEL_ORDER]


def build_meetings_by_week() -> list[dict]:
    """Placeholder until first-meetings aggregator is built.

    Returns last 8 weeks with zero counts so the chart renders meaningfully.
    Phase 2: wire to Calendly bookings + dial-tracker meeting-booked outcomes
    + Gmail reply heuristic.
    """
    out = []
    today = datetime.now(timezone.utc).date()
    monday = today - timedelta(days=today.weekday())
    for i in range(7, -1, -1):
        week_start = monday - timedelta(weeks=i)
        out.append({
            "week": week_start.isoformat(),
            "total": 0,
            "by_line": {"BRT": 0, "PMC": 0, "EWC": 0, "Fountain": 0, "Other": 0},
        })
    return out


def build_kpis(sequences: list[dict], dials_by_day: list[dict], meetings_by_week: list[dict]) -> dict:
    active_sequences = sum(1 for s in sequences if s["status"] == "active")
    today = datetime.now(timezone.utc).date()
    cutoff_7d = today - timedelta(days=7)
    dials_last_7d = sum(d["count"] for d in dials_by_day if d["date"] >= cutoff_7d.isoformat())
    meetings_this_week = meetings_by_week[-1]["total"] if meetings_by_week else 0
    total_contacts = sum(s["contacts"] for s in sequences)
    total_replied = sum(s["replied"] for s in sequences)
    reply_rate = (total_replied / total_contacts * 100) if total_contacts else 0.0
    return {
        "meetings_this_week": meetings_this_week,
        "dials_last_7d": dials_last_7d,
        "active_sequences": active_sequences,
        "reply_rate_14d": round(reply_rate, 2),
        "target_30d_meetings": 8,
        "target_90d_meetings": 15,
    }


def main() -> int:
    sequences = build_sequences()
    dials_by_day = build_dials_by_day()
    outcome_funnel = build_outcome_funnel()
    meetings_by_week = build_meetings_by_week()
    kpis = build_kpis(sequences, dials_by_day, meetings_by_week)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "apollo_csv": str(APOLLO_CSV.relative_to(JID_ROOT)) if APOLLO_CSV.exists() else None,
            "dial_history": str(DIAL_HISTORY) if DIAL_HISTORY.exists() else None,
        },
        "kpis": kpis,
        "sequences": sequences,
        "dials_by_day": dials_by_day,
        "outcome_funnel": outcome_funnel,
        "meetings_by_week": meetings_by_week,
    }

    if "--check" in sys.argv:
        print(json.dumps({
            "sequences_count": len(sequences),
            "dials_by_day_count": len(dials_by_day),
            "outcome_funnel": outcome_funnel,
            "kpis": kpis,
        }, indent=2))
        return 0

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2))
    print(f"[playground] Wrote {len(sequences)} sequences, {len(dials_by_day)} dial-day rows -> {OUT_PATH.relative_to(JID_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
