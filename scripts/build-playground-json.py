#!/usr/bin/env python3
"""Build Playground tab JSON from real data sources.

Aggregates:
  - Apollo API: live sequence stats (unique_sent, unique_replied, reply_rate, open_rate)
  - Apollo dial list CSV: per-row contact membership in early-warmup sequences
  - Dial tracker history: per-call outcomes + timestamps
  - First-meetings aggregator: weekly meetings by line (Calendly + dial + Apollo
    reply_class=willing_to_meet + Gmail), if present at HERMES_STATE/first-meetings-by-week.json

Output: packages/web/src/lib/playground.generated.json

Contract (stable — React route depends on this shape):
  {
    "generated_at": "ISO-8601",
    "kpis": { meetings_this_week, dials_last_7d, active_sequences, reply_rate_14d },
    "sequences": [{slug, name, brand, contacts, active, paused, sent, opened,
                   replied, reply_rate, open_rate, status, apollo_id}],
    "dials_by_day": [{date, outcome, count}],
    "outcome_funnel": [{stage, count}],
    "meetings_by_week": [{week, total, by_line: {...}}]
  }

Apollo cache: ~/.hermes/cache/apollo-stats-YYYY-MM-DD.json — refreshed if missing
or >6h old. Apollo API hits gated by APOLLO_API_KEY (loaded from
~/.hermes/secrets/jid5274/apollo.env).

When called with --check, prints the shape and exits.
When called with --no-apollo, skips Apollo API and uses CSV only (offline mode).
"""

from __future__ import annotations

import csv
import json
import os
import subprocess
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# --- Path resolution ---
SCRIPT_DIR = Path(__file__).resolve().parent
ARCHON_ROOT = SCRIPT_DIR.parent          # archon/
JID_ROOT = ARCHON_ROOT.parent             # jid5274/
VAULT = JID_ROOT / "second-brain"
HERMES = Path.home() / ".hermes"
HERMES_STATE = HERMES / "state"
HERMES_CACHE = HERMES / "cache"
HERMES_SECRETS = HERMES / "secrets" / "jid5274"

APOLLO_CSV = VAULT / "intelligence" / "briefs" / "2026-05-13-apollo-dial-list-all.csv"
APOLLO_ENV = HERMES_SECRETS / "apollo.env"
DIAL_HISTORY = HERMES_STATE / "dial_tracker_history.json"
DIAL_QUEUES_DIR = VAULT / "intelligence" / "briefs"  # YYYY-MM-DD-dial-queue.json files live here
FIRST_MEETINGS_STATE = HERMES_STATE / "first-meetings-by-week.json"

OUT_PATH = ARCHON_ROOT / "packages" / "web" / "src" / "lib" / "playground.generated.json"

APOLLO_CACHE_TTL_HOURS = 6

# --- Brand mapping ---
# Match against UPPER-CASED sequence name. Order matters — first matching
# substring wins. Apollo names like "Behavioral Health Sequence -- Therapy"
# get matched by "BEHAVIORAL HEALTH" or "BH".
BRAND_BY_NAME_SUBSTRING = [
    ("BEHAVIORAL HEALTH", "BRT"),
    ("BH_", "BRT"),
    ("CHIRO", "BRT"),
    ("MEDSPA", "BRT"),
    ("PMC", "PMC"),
    ("EWC", "EWC"),
    ("LUMNEN", "EWC"),
    ("TTTS", "TTTS"),
    ("QEP", "QEP"),
    ("IHHT", "IHHT"),
    ("SGINK", "SG INK"),
    ("SG INK", "SG INK"),
]

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


def detect_brand(name: str) -> str:
    """Match a sequence name to a brand by substring (case-insensitive)."""
    name_upper = (name or "").upper()
    for substring, brand in BRAND_BY_NAME_SUBSTRING:
        if substring in name_upper:
            return brand
    return "Unassigned"


def load_apollo_key() -> str | None:
    """Read APOLLO_API_KEY from disk-cached env file. Skill secrets-management
    pattern 8d: disk first, never call bw from cron."""
    if not APOLLO_ENV.exists():
        print(f"[playground] WARN: {APOLLO_ENV} missing — skipping Apollo",
              file=sys.stderr)
        return None
    for line in APOLLO_ENV.read_text().splitlines():
        line = line.strip()
        if line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        if k.strip() == "APOLLO_API_KEY":
            return v.strip().strip('"').strip("'")
    print(f"[playground] WARN: APOLLO_API_KEY not in {APOLLO_ENV}",
          file=sys.stderr)
    return None


def fetch_apollo_campaigns(api_key: str) -> list[dict]:
    """Hit POST /v1/emailer_campaigns/search and return the campaigns list.
    Sets curl-style User-Agent to bypass Cloudflare 1010 (apollo-daily-performance
    skill pitfall)."""
    body = json.dumps({"page": 1, "per_page": 100}).encode("utf-8")
    req = Request(
        "https://api.apollo.io/v1/emailer_campaigns/search",
        data=body,
        method="POST",
        headers={
            "X-Api-Key": api_key,
            "User-Agent": "curl/8.7.1",
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
        },
    )
    try:
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except (HTTPError, URLError, json.JSONDecodeError, TimeoutError) as e:
        print(f"[playground] WARN: Apollo fetch failed: {e}", file=sys.stderr)
        return []
    if data.get("error"):
        print(f"[playground] WARN: Apollo error: {data['error']} "
              f"(code={data.get('error_code')})", file=sys.stderr)
        if data.get("error_code") == "API_INACCESSIBLE":
            print("[playground] WARN: API_INACCESSIBLE = wrong key TYPE "
                  "(regular vs master). See apollo-daily-performance skill.",
                  file=sys.stderr)
        return []
    return data.get("emailer_campaigns", [])


def get_apollo_campaigns_cached(force: bool = False) -> list[dict]:
    """Return Apollo campaigns from cache if fresh, else refetch."""
    today = datetime.now(timezone.utc).date().isoformat()
    cache_path = HERMES_CACHE / f"apollo-stats-{today}.json"
    if cache_path.exists() and not force:
        age_hours = (time.time() - cache_path.stat().st_mtime) / 3600
        if age_hours < APOLLO_CACHE_TTL_HOURS:
            try:
                return json.loads(cache_path.read_text())
            except (json.JSONDecodeError, OSError) as e:
                print(f"[playground] WARN: cache read failed: {e}",
                      file=sys.stderr)

    api_key = load_apollo_key()
    if not api_key:
        return []
    campaigns = fetch_apollo_campaigns(api_key)
    if campaigns:
        try:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json.dumps(campaigns, indent=2))
            cache_path.chmod(0o600)
        except OSError as e:
            print(f"[playground] WARN: cache write failed: {e}", file=sys.stderr)
    return campaigns


def build_sequences(skip_apollo: bool = False) -> list[dict]:
    """Build the canonical sequence list. Apollo-first (live data + reply rates),
    augmented with contact counts from the CSV when sequence name matches.
    Falls back to CSV-only if Apollo unavailable."""
    apollo_campaigns: list[dict] = [] if skip_apollo else get_apollo_campaigns_cached()
    apollo_by_name_upper = {c["name"].upper(): c for c in apollo_campaigns}

    # CSV: build contact-count index keyed by sequence label
    csv_contacts: dict[str, dict] = defaultdict(
        lambda: {"contacts": 0, "active": 0, "paused": 0}
    )
    if APOLLO_CSV.exists():
        with APOLLO_CSV.open(encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                seq = (row.get("sequence") or "").strip()
                if not seq:
                    continue
                status = (row.get("sequence_status") or "").strip().lower()
                csv_contacts[seq]["contacts"] += 1
                if status == "active":
                    csv_contacts[seq]["active"] += 1
                elif status == "paused":
                    csv_contacts[seq]["paused"] += 1

    # CSV-to-Apollo name fuzzy map: CSV uses BH_PSYCH / BH_THERAPY etc.
    # Apollo uses "Behavioral Health Sequence -- Psychiatric" etc. We rely
    # on brand+token overlap to associate.
    CSV_TO_APOLLO_HINT = {
        "BH_PSYCH": "PSYCHIATRIC",
        "BH_THERAPY": "THERAPY",
        "CHIRO": "CHIRO",
        "MEDSPA": "MEDSPA",
        "PMC_ICP": "PMC",
    }

    def find_csv_match(apollo_name_upper: str) -> dict | None:
        for csv_key, hint in CSV_TO_APOLLO_HINT.items():
            if hint in apollo_name_upper and csv_key in csv_contacts:
                return csv_contacts[csv_key]
        return None

    sequences: list[dict] = []

    # Emit one record per Apollo campaign (active OR has any sent), enrich w/ CSV
    for c in apollo_campaigns:
        if c.get("archived"):
            continue
        name = c.get("name", "")
        sent = c.get("unique_delivered") or 0
        opened = c.get("unique_opened") or 0
        replied = c.get("unique_replied") or 0
        clicked = c.get("unique_clicked") or 0
        # Skip campaigns that are inactive AND have zero send history
        if not c.get("active") and sent == 0:
            continue
        csv_match = find_csv_match(name.upper())
        contacts = csv_match["contacts"] if csv_match else sent
        active = csv_match["active"] if csv_match else (sent if c.get("active") else 0)
        sequences.append({
            "slug": (c.get("id") or name.lower())[:24],
            "name": name,
            "brand": detect_brand(name),
            "apollo_id": c.get("id"),
            "contacts": contacts,
            "active": active,
            "paused": (csv_match["paused"] if csv_match else 0),
            "sent": sent,
            "opened": opened,
            "replied": replied,
            "clicked": clicked,
            "reply_rate": round((c.get("reply_rate") or 0) * 100, 2),
            "open_rate": round((c.get("open_rate") or 0) * 100, 2),
            "click_rate": round((c.get("click_rate") or 0) * 100, 2),
            "status": "active" if c.get("active") else "paused",
            "num_steps": c.get("num_steps") or 0,
        })

    # Fallback: CSV-only sequences not matched to Apollo (warmup/staging)
    matched_csv_keys = set()
    for c in apollo_campaigns:
        name_upper = (c.get("name") or "").upper()
        for csv_key, hint in CSV_TO_APOLLO_HINT.items():
            if hint in name_upper:
                matched_csv_keys.add(csv_key)
    for csv_key, agg in csv_contacts.items():
        if csv_key in matched_csv_keys:
            continue
        sequences.append({
            "slug": csv_key.lower().replace("_", "-"),
            "name": csv_key,
            "brand": detect_brand(csv_key),
            "apollo_id": None,
            "contacts": agg["contacts"],
            "active": agg["active"],
            "paused": agg["paused"],
            "sent": 0,
            "opened": 0,
            "replied": 0,
            "clicked": 0,
            "reply_rate": 0.0,
            "open_rate": 0.0,
            "click_rate": 0.0,
            "status": "active" if agg["active"] > 0 else "paused",
            "num_steps": 0,
        })

    # Sort: active first, then by replied count desc, then by contacts desc
    sequences.sort(
        key=lambda s: (
            0 if s["status"] == "active" else 1,
            -s["replied"],
            -s["contacts"],
        )
    )
    return sequences


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
    """Read live first-meetings-by-week.json if present, else zero-fill.

    Expected shape at FIRST_MEETINGS_STATE:
      {"2026-06-02": {"BRT": 2, "PMC": 1, "EWC": 0, "Fountain": 0, "Other": 0}, ...}

    Phase 2 cron `aggregate-first-meetings.py` produces this from Calendly +
    Apollo reply_class=willing_to_meet + dial-tracker meeting-booked + Gmail.
    """
    live: dict[str, dict] = {}
    if FIRST_MEETINGS_STATE.exists():
        try:
            live = json.loads(FIRST_MEETINGS_STATE.read_text())
        except (json.JSONDecodeError, OSError) as e:
            print(f"[playground] WARN: first-meetings state read failed: {e}",
                  file=sys.stderr)
            live = {}

    out = []
    today = datetime.now(timezone.utc).date()
    monday = today - timedelta(days=today.weekday())
    for i in range(7, -1, -1):
        week_start = monday - timedelta(weeks=i)
        wk = week_start.isoformat()
        by_line = live.get(wk, {})
        # Normalize against expected lines
        normalized = {
            "BRT": int(by_line.get("BRT", 0)),
            "PMC": int(by_line.get("PMC", 0)),
            "EWC": int(by_line.get("EWC", 0)),
            "Fountain": int(by_line.get("Fountain", 0)),
            "Other": int(by_line.get("Other", 0)),
        }
        total = sum(normalized.values())
        out.append({
            "week": wk,
            "total": total,
            "by_line": normalized,
        })
    return out


def build_kpis(sequences: list[dict], dials_by_day: list[dict], meetings_by_week: list[dict]) -> dict:
    active_sequences = sum(1 for s in sequences if s["status"] == "active")
    today = datetime.now(timezone.utc).date()
    cutoff_7d = today - timedelta(days=7)
    dials_last_7d = sum(d["count"] for d in dials_by_day if d["date"] >= cutoff_7d.isoformat())
    meetings_this_week = meetings_by_week[-1]["total"] if meetings_by_week else 0
    # Reply rate: use the live Apollo total (delivered + replied) since reply
    # rate is the actual KPI. Skip CSV-only sequences (no real data yet).
    total_delivered = sum(s["sent"] for s in sequences if s["apollo_id"])
    total_replied = sum(s["replied"] for s in sequences if s["apollo_id"])
    reply_rate = (total_replied / total_delivered * 100) if total_delivered else 0.0
    total_opened = sum(s["opened"] for s in sequences if s["apollo_id"])
    open_rate = (total_opened / total_delivered * 100) if total_delivered else 0.0
    return {
        "meetings_this_week": meetings_this_week,
        "dials_last_7d": dials_last_7d,
        "active_sequences": active_sequences,
        "reply_rate_14d": round(reply_rate, 2),
        "open_rate_14d": round(open_rate, 2),
        "total_delivered": total_delivered,
        "total_replied": total_replied,
        "target_30d_meetings": 8,
        "target_90d_meetings": 15,
    }


def main() -> int:
    skip_apollo = "--no-apollo" in sys.argv
    sequences = build_sequences(skip_apollo=skip_apollo)
    dials_by_day = build_dials_by_day()
    outcome_funnel = build_outcome_funnel()
    meetings_by_week = build_meetings_by_week()
    kpis = build_kpis(sequences, dials_by_day, meetings_by_week)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "apollo_api": "live" if not skip_apollo else "skipped",
            "apollo_csv": str(APOLLO_CSV.relative_to(JID_ROOT)) if APOLLO_CSV.exists() else None,
            "dial_history": str(DIAL_HISTORY) if DIAL_HISTORY.exists() else None,
            "first_meetings_state": (
                str(FIRST_MEETINGS_STATE) if FIRST_MEETINGS_STATE.exists() else "missing (zero-fill)"
            ),
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
            "sequences_summary": [
                {"name": s["name"], "brand": s["brand"], "sent": s["sent"],
                 "replied": s["replied"], "reply_rate": s["reply_rate"]}
                for s in sequences[:10]
            ],
            "dials_by_day_count": len(dials_by_day),
            "outcome_funnel": outcome_funnel,
            "kpis": kpis,
        }, indent=2))
        return 0

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2))
    print(f"[playground] Wrote {len(sequences)} sequences, "
          f"{len(dials_by_day)} dial-day rows, "
          f"{sum(s['replied'] for s in sequences)} total replied "
          f"-> {OUT_PATH.relative_to(JID_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
