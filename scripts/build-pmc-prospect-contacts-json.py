#!/usr/bin/env python3
"""Build the PMC dashboard prospect/contact worklist.

Inputs are vault-stored source exports, not browser-live APIs:
- consolidated prospect master CSV from Jason's uploaded file
- Sales Navigator name-only DOCX list
- dial tracker history JSON
- Apollo sequence summary snapshot when available

Output: packages/web/src/lib/pmc-prospect-contacts.generated.json
"""
from __future__ import annotations

import csv
import json
import re
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
ARCHON_ROOT = SCRIPT_DIR.parent
JID_ROOT = ARCHON_ROOT.parent
VAULT = JID_ROOT / "second-brain"
SOURCES = VAULT / "intelligence" / "prospects" / "sources"
CONSOLIDATED_CSV = SOURCES / "2026-06-11-consolidated-prospects-v9-alt-contacts-master.csv"
SALES_NAV_DOCX = SOURCES / "2026-06-17-sales-navigator-prospect-list-1-to-155.docx"
DIAL_HISTORY = Path.home() / ".hermes" / "state" / "dial_tracker_history.json"
PLAYGROUND_JSON = ARCHON_ROOT / "packages" / "web" / "src" / "lib" / "playground.generated.json"
OUT_PATH = ARCHON_ROOT / "packages" / "web" / "src" / "lib" / "pmc-prospect-contacts.generated.json"
VAULT_EXPORT = VAULT / "intelligence" / "prospects" / "2026-06-17-pmc-prospect-contacts-snapshot.json"

SEQUENCE_NAMES = {
    "699cd7f19c628f001d095cc4": "US PMC ICP Verified Only",
    "698f86da485ea40010fcfc19": "Andrew's Outbound AI Sequence 2",
    "6a03e3072cb7c80015b5a288": "Behavioral Health Sequence -- Therapy",
    "6a03e2fed5095c001d2e2c78": "Behavioral Health Sequence -- Psychiatric",
    "69ea4d1207b925001d6b3afa": "Chiro Sequence -- BRT/PMC(SOMA)",
    "69f0f72379dfb40019372627": "Medspa Sequence 1",
}

SEQUENCE_BRANDS = {
    "699cd7f19c628f001d095cc4": "PMC",
    "698f86da485ea40010fcfc19": "PMC",
    "6a03e3072cb7c80015b5a288": "BRT",
    "6a03e2fed5095c001d2e2c78": "BRT",
    "69ea4d1207b925001d6b3afa": "BRT",
    "69f0f72379dfb40019372627": "BRT",
}

NAME_PREFIX_RE = re.compile(r"^(dr\.?|doctor|mr\.?|mrs\.?|ms\.?)\s+", re.I)
NON_NAME_SUFFIX_RE = re.compile(r",?\s*(md|m\.d\.|do|d\.o\.|dc|d\.c\.|dpt|pt|phd|mba|ms|mha|aprn|lcsw|lpc|facs|faafp|faap|fnp-c|cert\.?\s*mdt|cscs|ocs|mtc|gcs|comt|dabci|faacp|mse?d|caccp|bsc|ba|rrt|rpft|lat|fafs|lisw|licdc|supervisor|abpp|fasm|fasrs|fasn|fucm)\b.*$", re.I)


def clean(value: Any) -> str:
    return str(value or "").strip()


def normalize_phone(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    if len(digits) == 11 and digits.startswith("1"):
        return "+" + digits
    if len(digits) == 10:
        return "+1" + digits
    return value.strip()


def display_name(name: str) -> str:
    name = re.sub(r"\s+", " ", clean(name))
    return name


def name_key(name: str) -> str:
    value = NAME_PREFIX_RE.sub("", clean(name)).strip()
    value = NON_NAME_SUFFIX_RE.sub("", value).strip()
    value = re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()
    return value


def company_key(company: str) -> str:
    value = re.sub(r"\([^)]*\)", "", clean(company).lower())
    value = re.sub(r"\b(llc|inc|pllc|pa|pc|corp|corporation|company|co|ltd)\b", "", value)
    value = re.sub(r"[^a-z0-9]+", " ", value).strip()
    return value


def row_key(name: str, company: str, email: str, linkedin: str, phone: str) -> str:
    if clean(email):
        return f"email:{clean(email).lower()}"
    if clean(linkedin):
        return f"linkedin:{clean(linkedin).lower().rstrip('/')}"
    nk = name_key(name)
    ck = company_key(company)
    if nk and ck:
        return f"nameco:{nk}|{ck}"
    if nk and phone:
        return f"namephone:{nk}|{normalize_phone(phone)}"
    return f"name:{nk or clean(name).lower()}"


def parse_docx_names(path: Path) -> list[str]:
    if not path.exists():
        return []
    with zipfile.ZipFile(path) as archive:
        xml = archive.read("word/document.xml").decode("utf-8")
    text = re.sub(r"<[^>]+>", " ", xml)
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"^.*?Sales Navigator Prospect List \(1-155\)\s*", "", text)
    names = []
    for match in re.finditer(r"(?:^|\s)(\d{1,3})\.\s+(.+?)(?=\s+\d{1,3}\.\s+|$)", text):
        index = int(match.group(1))
        if 1 <= index <= 155:
            names.append(display_name(match.group(2)))
    return names


def sequence_label(ids: str) -> str:
    seq_ids = [part.strip() for part in clean(ids).split(",") if part.strip()]
    return "; ".join(SEQUENCE_NAMES.get(seq_id, seq_id) for seq_id in seq_ids)


def brand_fit(row: dict[str, str], sales_nav: bool = False) -> list[str]:
    text = " ".join(clean(row.get(k)) for k in ["company", "specialty", "notes", "in_sequence", "source"]).lower()
    fits: list[str] = []
    for seq_id in [part.strip() for part in clean(row.get("in_sequence")).split(",") if part.strip()]:
        brand = SEQUENCE_BRANDS.get(seq_id)
        if brand and brand not in fits:
            fits.append(brand)
    if any(term in text for term in ["chiro", "physical therapy", " pt", "therapy", "behavioral", "psychi", "mental", "medspa", "aesthetic", "longevity", "wellness"]):
        if "BRT" not in fits:
            fits.append("BRT")
    if any(term in text for term in ["concierge", "direct primary", "dpc", "primary care", "practice", "cardio", "dental", "omfs", "physician"]):
        if "PMC" not in fits:
            fits.append("PMC")
    if any(term in text for term in ["weave", "phone", "front desk", "inbound", "missed call"]):
        if "Weave" not in fits:
            fits.append("Weave")
    if any(term in text for term in ["neural", "cloud", "ai", "automation"]):
        if "Neural Cloud" not in fits:
            fits.append("Neural Cloud")
    if sales_nav and not fits:
        fits.append("Research needed")
    return fits[:4] or ["PMC"]


def infer_angle(fits: list[str], row: dict[str, str], source_context: str) -> str:
    text = " ".join([clean(row.get("company")), clean(row.get("specialty")), clean(row.get("notes")), source_context]).lower()
    if "BRT" in fits:
        if "behavioral" in text or "therapy" in text or "lcsw" in text or "psych" in text:
            return "BRT clinical differentiation for dysregulation, recovery, and patient-retention conversations."
        if "chiro" in text or "physical therapy" in text or " pt" in text:
            return "BRT recovery-tech angle for hands-on practices already selling outcomes and retention."
        if "medspa" in text or "aesthetic" in text:
            return "BRT/Cellcom as a premium recovery and skin-health adjunct for wellness/aesthetics buyers."
        return "BRT wellness-tech angle; validate specialty before pitching."
    if "Weave" in fits:
        return "Weave/front-desk leakage angle: missed calls, follow-up, patient communication, and collections."
    if "Neural Cloud" in fits:
        return "Neural Cloud workflow angle: AI-enabled follow-up, intake, and operating leverage."
    if "PMC" in fits:
        if "direct primary" in text or "concierge" in text:
            return "PMC advisory angle around boutique-practice growth, patient access, and revenue operations."
        return "PMC practice-management angle: revenue leakage, access leakage, and leadership bandwidth."
    return "Research fit first, then choose PMC/BRT/Weave/Narrow Cloud lane."


def merge_field(record: dict[str, Any], field: str, value: str) -> None:
    value = clean(value)
    if value and not clean(record.get(field)):
        record[field] = value


def load_dials() -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    if not DIAL_HISTORY.exists():
        return out
    raw = json.loads(DIAL_HISTORY.read_text())
    attempts: list[dict[str, Any]] = []
    for value in raw.values():
        values = value if isinstance(value, list) else [value]
        for item in values:
            if isinstance(item, dict):
                attempts.append(item)
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in attempts:
        key = name_key(clean(item.get("name")))
        if not key:
            continue
        text = " ".join(clean(item.get(k)) for k in ["notes", "outcome", "called_at", "phone_called", "timestamp"])
        if item.get("outcome") == "closed-test" or "No dial action required" in text:
            continue
        if item.get("called_at") or item.get("phone_called") or re.search(r"\b(dialed|called|spoke|voicemail|callback|gatekeeper|no answer|texted|vm left)\b", text, re.I):
            grouped[key].append(item)
    for key, items in grouped.items():
        items.sort(key=lambda x: clean(x.get("called_at") or x.get("timestamp")))
        latest = items[-1]
        out[key] = {
            "dial_last_attempt": clean(latest.get("called_at") or latest.get("timestamp"))[:10],
            "dial_last_outcome": clean(latest.get("outcome")),
            "dial_attempt_count": len(items),
            "dial_notes": clean(latest.get("notes")),
            "phone": clean(latest.get("phone_called") or latest.get("phone")),
        }
    return out


def strategic_state(record: dict[str, Any]) -> str:
    latest = " ".join([clean(record.get("latest_outcome")), clean(record.get("dial_last_outcome")), clean(record.get("notes")), clean(record.get("priority"))]).lower()
    if any(term in latest for term in ["meeting", "interested", "willing_to_meet", "follow-up", "callback-pending", "gatekeeper"]):
        return "hot"
    if any(term in latest for term in ["reply", "replied", "warm", "linkedin"]):
        return "engaged"
    if any(term in latest for term in ["not-interested", "dnc", "wrong-number", "closed-no-response", "closed-stale"]):
        return "dead"
    if record.get("apollo_sequence_name") or record.get("salesnav_present") or record.get("dial_attempt_count", 0) > 0:
        return "warmup-active"
    return "cold"


def next_action(record: dict[str, Any]) -> str:
    state = record.get("strategic_state")
    if state == "hot":
        return "Manual follow-up: convert live signal into a first meeting or clear callback slot."
    if state == "engaged":
        return "Continue in the active reply channel; pause cold automation until thread resolves."
    if state == "dead":
        return "Suppress from active push unless Jason reopens with new context."
    channels = record.get("channels_open", [])
    if "Dial" in channels and record.get("phone"):
        return "Dial with the listed approach angle, then log outcome."
    if "LinkedIn" in channels and record.get("linkedin_url"):
        return "Layer LinkedIn touch; avoid repeating the Apollo subject line verbatim."
    if "Apollo" in channels and record.get("email"):
        return "Add/confirm Apollo sequence after dual-brand and one-contact-per-company audit."
    if not record.get("email") or not record.get("phone") or not record.get("linkedin_url"):
        return "Research missing contact fields before next outbound touch."
    return "Triage for next best channel based on latest signal."


def build() -> None:
    dials_by_name = load_dials()
    sales_nav_names = parse_docx_names(SALES_NAV_DOCX)
    records: dict[str, dict[str, Any]] = {}

    if CONSOLIDATED_CSV.exists():
        with CONSOLIDATED_CSV.open(newline="", encoding="utf-8-sig") as handle:
            for row in csv.DictReader(handle):
                name = display_name(row.get("name", ""))
                if not name:
                    continue
                email = clean(row.get("email"))
                phone = normalize_phone(clean(row.get("phone")))
                linkedin = clean(row.get("linkedin_url"))
                key = row_key(name, row.get("company", ""), email, linkedin, phone)
                if key not in records:
                    seq_name = sequence_label(row.get("in_sequence", ""))
                    fits = brand_fit(row)
                    channels = []
                    if row.get("in_sequence") or row.get("source") == "Apollo":
                        channels.append("Apollo")
                    if row.get("source") == "HeyReach-LinkedIn" or linkedin:
                        channels.append("LinkedIn")
                    records[key] = {
                        "id": key,
                        "name": name,
                        "company": clean(row.get("company")),
                        "title": clean(row.get("specialty")),
                        "specialty": clean(row.get("specialty")),
                        "email": email,
                        "phone": phone,
                        "linkedin_url": linkedin,
                        "website": clean(row.get("website")),
                        "city": clean(row.get("city")),
                        "state": clean(row.get("state")),
                        "source": clean(row.get("source")),
                        "source_url": clean(row.get("source_url")),
                        "priority": clean(row.get("priority")),
                        "rating": clean(row.get("rating")),
                        "review_count": clean(row.get("review_count")),
                        "revenue_est": clean(row.get("revenue_est")),
                        "stop_by_this_week": clean(row.get("stop_by_this_week")) == "YES",
                        "apollo_sequence_id": clean(row.get("in_sequence")),
                        "apollo_sequence_name": seq_name,
                        "apollo_last_open": "",
                        "apollo_last_reply": "",
                        "apollo_replies": 0,
                        "apollo_opens": 0,
                        "salesnav_present": False,
                        "salesnav_last_touch": "",
                        "salesnav_thread_summary": "",
                        "heyreach_present": clean(row.get("source")) == "HeyReach-LinkedIn",
                        "notes": clean(row.get("notes")),
                        "brand_fit": fits,
                        "approach_angle": infer_angle(fits, row, seq_name),
                        "engagement_subjects": [seq_name] if seq_name else [],
                        "channels_covered": sorted(set(channels)),
                        "source_rows": 1,
                    }
                else:
                    record = records[key]
                    record["source_rows"] = int(record.get("source_rows", 1)) + 1
                    for field, col in [("company", "company"), ("email", "email"), ("phone", "phone"), ("linkedin_url", "linkedin_url"), ("website", "website"), ("city", "city"), ("state", "state"), ("priority", "priority"), ("notes", "notes")]:
                        merge_field(record, field, normalize_phone(row.get(col, "")) if field == "phone" else row.get(col, ""))
                    if row.get("in_sequence"):
                        seq_name = sequence_label(row.get("in_sequence", ""))
                        merge_field(record, "apollo_sequence_id", row.get("in_sequence", ""))
                        merge_field(record, "apollo_sequence_name", seq_name)
                        if seq_name and seq_name not in record["engagement_subjects"]:
                            record["engagement_subjects"].append(seq_name)
                        if "Apollo" not in record["channels_covered"]:
                            record["channels_covered"].append("Apollo")

    # Overlay Sales Navigator list as name-only coverage or fresh research rows.
    for name in sales_nav_names:
        nk = name_key(name)
        if not nk:
            continue
        match_key = next((key for key, rec in records.items() if name_key(rec["name"]) == nk), "")
        if not match_key:
            key = f"salesnav:{nk}"
            row = {"name": name, "company": "", "specialty": "", "notes": "Sales Navigator prospect list 1-155"}
            fits = brand_fit(row, sales_nav=True)
            records[key] = {
                "id": key,
                "name": name,
                "company": "",
                "title": "",
                "specialty": "",
                "email": "",
                "phone": "",
                "linkedin_url": "",
                "website": "",
                "city": "",
                "state": "",
                "source": "Sales Navigator",
                "source_url": "",
                "priority": "",
                "rating": "",
                "review_count": "",
                "revenue_est": "",
                "stop_by_this_week": False,
                "apollo_sequence_id": "",
                "apollo_sequence_name": "",
                "apollo_last_open": "",
                "apollo_last_reply": "",
                "apollo_replies": 0,
                "apollo_opens": 0,
                "salesnav_present": True,
                "salesnav_last_touch": "",
                "salesnav_thread_summary": "Sales Navigator list; thread visibility is manual unless Jason provides screenshot/paste.",
                "heyreach_present": False,
                "notes": "Sales Navigator prospect list only; research needed for company/contact fields.",
                "brand_fit": fits,
                "approach_angle": infer_angle(fits, row, "Sales Navigator"),
                "engagement_subjects": ["Sales Navigator prospect list"],
                "channels_covered": ["LinkedIn"],
                "source_rows": 1,
            }
        else:
            rec = records[match_key]
            rec["salesnav_present"] = True
            rec["salesnav_thread_summary"] = rec.get("salesnav_thread_summary") or "Present on Sales Navigator list; message history manual-only."
            if "LinkedIn" not in rec["channels_covered"]:
                rec["channels_covered"].append("LinkedIn")
            if "Sales Navigator prospect list" not in rec["engagement_subjects"]:
                rec["engagement_subjects"].append("Sales Navigator prospect list")

    # Overlay dial history by cleaned name.
    for rec in records.values():
        dial = dials_by_name.get(name_key(rec["name"]))
        if dial:
            rec.update({k: v for k, v in dial.items() if k != "phone"})
            if dial.get("phone") and not rec.get("phone"):
                rec["phone"] = dial["phone"]
            if "Dial" not in rec["channels_covered"]:
                rec["channels_covered"].append("Dial")
            if dial.get("dial_last_outcome") and dial["dial_last_outcome"] not in rec["engagement_subjects"]:
                rec["engagement_subjects"].append(f"Dial: {dial['dial_last_outcome']}")
        else:
            rec["dial_last_attempt"] = ""
            rec["dial_last_outcome"] = ""
            rec["dial_attempt_count"] = 0
            rec["dial_notes"] = ""

    # Add dial-only rows that were not in the consolidated CSV / Sales Nav source.
    existing_names = {name_key(rec["name"]) for rec in records.values()}
    for nk, dial in dials_by_name.items():
        if nk in existing_names:
            continue
        name = " ".join(part.capitalize() for part in nk.split())
        key = f"dial:{nk}"
        row = {"name": name, "company": "", "specialty": "", "notes": clean(dial.get("dial_notes"))}
        fits = brand_fit(row)
        records[key] = {
            "id": key,
            "name": name,
            "company": "",
            "title": "",
            "specialty": "",
            "email": "",
            "phone": clean(dial.get("phone")),
            "linkedin_url": "",
            "website": "",
            "city": "",
            "state": "",
            "source": "Dial tracker",
            "source_url": "",
            "priority": "",
            "rating": "",
            "review_count": "",
            "revenue_est": "",
            "stop_by_this_week": False,
            "apollo_sequence_id": "",
            "apollo_sequence_name": "",
            "apollo_last_open": "",
            "apollo_last_reply": "",
            "apollo_replies": 0,
            "apollo_opens": 0,
            "salesnav_present": False,
            "salesnav_last_touch": "",
            "salesnav_thread_summary": "",
            "heyreach_present": False,
            "notes": clean(dial.get("dial_notes")),
            "brand_fit": fits,
            "approach_angle": infer_angle(fits, row, "Dial tracker"),
            "engagement_subjects": [f"Dial: {dial.get('dial_last_outcome', '')}"],
            "channels_covered": ["Dial"],
            "source_rows": 1,
            **{k: v for k, v in dial.items() if k != "phone"},
        }

    for rec in records.values():
        covered = set(rec.get("channels_covered", []))
        channels_open = [c for c in ["Apollo", "LinkedIn", "Dial"] if c not in covered]
        rec["channels_covered"] = sorted(covered)
        rec["channels_open"] = channels_open
        rec["channels_covered_count"] = len(covered)
        rec["missing_fields"] = [field for field in ["email", "phone", "linkedin_url", "company"] if not clean(rec.get(field))]
        rec["latest_engagement"] = rec.get("dial_last_attempt") or rec.get("apollo_last_reply") or rec.get("apollo_last_open") or rec.get("salesnav_last_touch") or ""
        rec["latest_outcome"] = rec.get("dial_last_outcome") or ("Apollo sequence" if rec.get("apollo_sequence_name") else "") or ("Sales Navigator" if rec.get("salesnav_present") else "")
        rec["strategic_state"] = strategic_state(rec)
        rec["next_action"] = next_action(rec)
        rec["engagement_subjects"] = [s for s in rec.get("engagement_subjects", []) if clean(s)][:4]

    rows = list(records.values())
    state_rank = {"hot": 0, "engaged": 1, "warmup-active": 2, "cold": 3, "dead": 4}
    rows.sort(key=lambda r: (state_rank.get(r["strategic_state"], 9), -int(r.get("channels_covered_count", 0)), len(r.get("missing_fields", [])), clean(r.get("name")).lower()))

    totals = {
        "prospects": len(rows),
        "hot": sum(1 for r in rows if r["strategic_state"] == "hot"),
        "engaged": sum(1 for r in rows if r["strategic_state"] == "engaged"),
        "warmup_active": sum(1 for r in rows if r["strategic_state"] == "warmup-active"),
        "cold": sum(1 for r in rows if r["strategic_state"] == "cold"),
        "dead": sum(1 for r in rows if r["strategic_state"] == "dead"),
        "missing_email": sum(1 for r in rows if not r.get("email")),
        "missing_phone": sum(1 for r in rows if not r.get("phone")),
        "missing_linkedin": sum(1 for r in rows if not r.get("linkedin_url")),
        "apollo_covered": sum(1 for r in rows if "Apollo" in r.get("channels_covered", [])),
        "linkedin_covered": sum(1 for r in rows if "LinkedIn" in r.get("channels_covered", [])),
        "dial_covered": sum(1 for r in rows if "Dial" in r.get("channels_covered", [])),
    }
    brand_counts = Counter(brand for r in rows for brand in r.get("brand_fit", []))
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "sources": {
            "consolidated_csv": str(CONSOLIDATED_CSV.relative_to(VAULT)),
            "sales_nav_docx": str(SALES_NAV_DOCX.relative_to(VAULT)),
            "dial_history": str(DIAL_HISTORY),
            "playground_json": str(PLAYGROUND_JSON.relative_to(ARCHON_ROOT)) if PLAYGROUND_JSON.exists() else "",
        },
        "notes": [
            "Sales Navigator manual DM bodies are not API-readable; salesnav_thread_summary is manual until Jason provides screenshots/pastes or HeyReach owns the thread.",
            "Apollo opens/replies are schema-ready but only populated when per-contact Apollo activity snapshots are available.",
            "Rows are deduped by email, LinkedIn URL, then name/company or name/phone.",
        ],
        "totals": totals,
        "brand_counts": dict(brand_counts),
        "prospects": rows,
    }
    OUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    VAULT_EXPORT.parent.mkdir(parents=True, exist_ok=True)
    VAULT_EXPORT.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"[pmc-prospect-contacts] Wrote {len(rows)} prospects -> {OUT_PATH.relative_to(ARCHON_ROOT)}")
    print(json.dumps(totals, indent=2))


if __name__ == "__main__":
    build()
