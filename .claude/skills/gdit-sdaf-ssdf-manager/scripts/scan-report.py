#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
#   "rich>=13.0.0",
# ]
# ///
"""Consolidated scan report with rich tables, pagination, detail view, source download, and cleanup."""

import argparse
import atexit
import hashlib
import json
import os
import shutil
import signal
import sys
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path

import boto3
from rich.console import Console
from rich.table import Table
from rich.text import Text

SESSION_FILE = Path(__file__).resolve().parent.parent / ".session.json"
OVERRIDES_KEY = "manifests/finding-overrides.json"
SEVERITY_ORDER = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "INFORMATIONAL": 4, "INFO": 4, "UNKNOWN": 5}
SEVERITY_COLORS = {"CRITICAL": "bright_red", "HIGH": "red", "MEDIUM": "yellow", "LOW": "dim", "INFO": "dim", "INFORMATIONAL": "dim", "UNKNOWN": "dim"}
SECURITY_SCANNERS = {"semgrep", "kics", "trivy", "checkov", "gitleaks"}

console = Console()
_temp_dir = None


# --- Cleanup ---

def _cleanup():
    global _temp_dir
    if _temp_dir and Path(_temp_dir).exists():
        shutil.rmtree(_temp_dir, ignore_errors=True)

def _signal_handler(sig, frame):
    _cleanup()
    sys.exit(1)


# --- Session ---

def load_session(profile_override=None, pipeline_override=None):
    if profile_override and pipeline_override:
        session = boto3.Session(profile_name=profile_override)
        sts = session.client("sts")
        identity = sts.get_caller_identity()
        account_id = identity["Account"]
        region = session.region_name or "us-east-1"
        return {
            "profile_name": profile_override, "account_id": account_id,
            "region": region, "arn": identity["Arn"],
            "pipeline_name": pipeline_override,
            "artifact_bucket": f"{pipeline_override}-artifacts-{account_id}-{region}",
        }
    if not SESSION_FILE.exists():
        console.print("[red]❌ No session found. Run select-profile.py first, or pass --profile and --pipeline.[/]")
        sys.exit(1)
    with open(SESSION_FILE) as f:
        session = json.load(f)
    if not session.get("pipeline_name"):
        console.print("[red]❌ No pipeline configured. Run select-profile.py first, or pass --pipeline.[/]")
        sys.exit(1)
    if profile_override:
        session["profile_name"] = profile_override
    return session


# --- Helpers ---

def generate_finding_id(pipeline_name, tool, rule, file, line):
    raw = f"{tool}|{rule}|{file}|{line}"
    return f"{pipeline_name}/{hashlib.sha256(raw.encode()).hexdigest()}"


def _parse_selection(selection_str, max_index):
    indices = []
    for part in selection_str.split(","):
        part = part.strip()
        if "-" in part:
            try:
                start, end = part.split("-", 1)
                for i in range(int(start), int(end) + 1):
                    if 1 <= i <= max_index:
                        indices.append(i - 1)
            except ValueError:
                pass
        else:
            try:
                i = int(part)
                if 1 <= i <= max_index:
                    indices.append(i - 1)
            except ValueError:
                pass
    return sorted(set(indices))


# --- Scanner parsers ---

def parse_semgrep(data):
    findings = []
    for r in data.get("results", []):
        findings.append({
            "tool": "semgrep", "rule": r.get("check_id", "unknown"),
            "file": r.get("path", "unknown"), "line": str(r.get("start", {}).get("line", 0)),
            "severity": r.get("extra", {}).get("severity", "UNKNOWN").upper(),
            "description": r.get("extra", {}).get("message", "")[:200],
        })
    return findings

def parse_kics(data):
    findings = []
    for query in data.get("queries", []):
        rule = query.get("query_name", query.get("query_id", "unknown"))
        severity = query.get("severity", "UNKNOWN").upper()
        desc = query.get("description", "")[:200]
        for f in query.get("files", []):
            findings.append({
                "tool": "kics", "rule": rule, "file": f.get("file_name", "unknown"),
                "line": str(f.get("line", 0)), "severity": severity, "description": desc,
            })
    return findings

def parse_trivy(data):
    findings = []
    for result in data.get("Results", []):
        target = result.get("Target", "unknown")
        for vuln in result.get("Vulnerabilities", []):
            findings.append({
                "tool": "trivy", "rule": vuln.get("VulnerabilityID", "unknown"),
                "file": target, "line": "0", "severity": vuln.get("Severity", "UNKNOWN").upper(),
                "description": vuln.get("Title", "")[:200],
            })
        for mc in result.get("Misconfigurations", []):
            findings.append({
                "tool": "trivy", "rule": mc.get("ID", "unknown"), "file": target,
                "line": "0", "severity": mc.get("Severity", "UNKNOWN").upper(),
                "description": mc.get("Title", "")[:200],
            })
    return findings

def parse_checkov(data):
    findings = []
    for check in data.get("results", {}).get("failed_checks", []):
        findings.append({
            "tool": "checkov", "rule": check.get("check_id", "unknown"),
            "file": check.get("file_path", "unknown"),
            "line": str(check.get("file_line_range", [0])[0]),
            "severity": check.get("severity", "MEDIUM").upper() if check.get("severity") else "MEDIUM",
            "description": check.get("check_name", "")[:200],
        })
    return findings

def parse_gitleaks(data):
    if not isinstance(data, list):
        return []
    return [{
        "tool": "gitleaks", "rule": leak.get("RuleID", "unknown"),
        "file": leak.get("File", "unknown"), "line": str(leak.get("StartLine", 0)),
        "severity": "HIGH", "description": leak.get("Description", "")[:200],
    } for leak in data]

def detect_and_parse(data, filename=""):
    filename.lower()
    if isinstance(data, list):
        if data and "RuleID" in data[0]:
            return parse_gitleaks(data)
        return []
    if "results" in data and isinstance(data["results"], list) and data["results"] and "check_id" in data["results"][0]:
        return parse_semgrep(data)
    if "queries" in data:
        return parse_kics(data)
    if "Results" in data:
        return parse_trivy(data)
    if "results" in data and isinstance(data["results"], dict) and "failed_checks" in data["results"]:
        return parse_checkov(data)
    if "results" in data:
        return parse_semgrep(data)
    return []


# --- S3 helpers ---

def list_scan_runs(s3, bucket, limit=10):
    runs = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix="runs/", Delimiter="/"):
        for prefix in page.get("CommonPrefixes", []):
            version = prefix["Prefix"].replace("runs/", "").rstrip("/")
            for vpage in paginator.paginate(Bucket=bucket, Prefix=prefix["Prefix"], Delimiter="/"):
                for bp in vpage.get("CommonPrefixes", []):
                    if "security-validation" in bp["Prefix"]:
                        try:
                            resp = s3.list_objects_v2(Bucket=bucket, Prefix=bp["Prefix"], MaxKeys=1)
                            if resp.get("KeyCount", 0) > 0:
                                last_mod = resp["Contents"][0].get("LastModified", datetime.min.replace(tzinfo=timezone.utc))
                                runs.append({"version": version, "prefix": bp["Prefix"], "last_modified": last_mod})
                        except Exception:
                            continue
    runs.sort(key=lambda r: r["last_modified"], reverse=True)
    return runs[:limit]

def list_report_keys(s3, bucket, prefix):
    keys = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            if obj["Key"].endswith(".json"):
                keys.append(obj["Key"])
    return keys

def download_overrides(s3, bucket):
    try:
        resp = s3.get_object(Bucket=bucket, Key=OVERRIDES_KEY)
        return json.loads(resp["Body"].read().decode("utf-8"))
    except Exception:
        return {"version": "1.0", "overrides": []}

def build_override_index(overrides, pipeline_name):
    by_id = set()
    by_key = {}
    for o in overrides.get("overrides", []):
        by_id.add(o.get("finding_id", ""))
        by_key[(o.get("tool", ""), o.get("rule", ""), o.get("file", ""))] = o
    return by_id, by_key

def match_override(finding, pipeline_name, by_id, by_key):
    fid = generate_finding_id(pipeline_name, finding["tool"], finding["rule"], finding["file"], finding["line"])
    if fid in by_id:
        return by_key.get((finding["tool"], finding["rule"], finding["file"]))
    return by_key.get((finding["tool"], finding["rule"], finding["file"]))

def override_label(entry):
    if not entry:
        return ""
    disp = entry.get("disposition", "")
    expires = entry.get("expires", "")
    try:
        if date.fromisoformat(expires) < date.today():
            return "⚠️  EXPIRED"
    except (ValueError, TypeError):
        pass
    tag = "FP" if disp == "false_positive" else "AR" if disp == "accepted_risk" else disp
    return f"✅ {tag} (exp {expires})"


# --- Source download ---

def download_source(s3, bucket, run_prefix, no_cleanup=False):
    """Download and extract source ZIP for AI review. Returns temp dir path or None."""
    global _temp_dir
    # Primary: fixed key persisted by Security Validation (REQ-32)
    source_key = "source/latest.zip"
    try:
        s3.head_object(Bucket=bucket, Key=source_key)
    except Exception:
        source_key = None
        # Fallback: search runs/ prefix for backward compatibility
        version_prefix = run_prefix.split("/")[0] + "/" + run_prefix.split("/")[1] + "/"
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=f"runs/{version_prefix}"):
            for obj in page.get("Contents", []):
                if obj["Key"].endswith(".zip"):
                    source_key = obj["Key"]
                    break
            if source_key:
                break
    if not source_key:
        console.print("[yellow]   ⚠️  Source ZIP not found — AI review will run in degraded mode[/]")
        return None

    temp_dir = Path("temp")
    if sys.platform != "win32":
        os.makedirs(temp_dir, mode=0o700, exist_ok=True)
    else:
        os.makedirs(temp_dir, exist_ok=True)
    (temp_dir / ".gitignore").write_text("*\n")

    zip_path = temp_dir / "source.zip"
    console.print(f"   📥 Downloading source: {source_key.split('/')[-1]}")
    s3.download_file(bucket, source_key, str(zip_path))

    extract_dir = temp_dir / "source"
    if sys.platform != "win32":
        os.makedirs(extract_dir, mode=0o700, exist_ok=True)
    else:
        os.makedirs(extract_dir, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(extract_dir)
    zip_path.unlink()

    file_count = sum(1 for _ in extract_dir.rglob("*") if _.is_file())
    console.print(f"   ✅ Extracted {file_count} files to temp/source/")

    _temp_dir = str(temp_dir)
    if not no_cleanup:
        atexit.register(_cleanup)
        signal.signal(signal.SIGINT, _signal_handler)
        if sys.platform != "win32":
            signal.signal(signal.SIGTERM, _signal_handler)
    else:
        console.print("[yellow]   ⚠️  --no-cleanup: temp/ will NOT be deleted on exit[/]")

    return str(extract_dir)


# --- Display ---

def build_summary_header(enriched, version, ts):
    active = sum(1 for f in enriched if not f.get("override"))
    overridden = sum(1 for f in enriched if f.get("override"))
    by_sev = {}
    for f in enriched:
        by_sev.setdefault(f["severity"], {"total": 0, "overridden": 0})
        by_sev[f["severity"]]["total"] += 1
        if f.get("override"):
            by_sev[f["severity"]]["overridden"] += 1

    console.print(f"\n[bold]📊 Scan Report — v{version}  ({ts})[/]")
    console.print(f"   Total: {len(enriched)}  |  Active: {active}  |  Overridden: {overridden}\n")
    for sev in ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFORMATIONAL", "INFO"]:
        if sev in by_sev:
            s = by_sev[sev]
            color = SEVERITY_COLORS.get(sev, "white")
            ovr = f"  ({s['overridden']} overridden)" if s["overridden"] else ""
            console.print(f"   [{color}]{sev:<14}[/] {s['total']}{ovr}")
    console.print()


def build_page_table(enriched, page, page_size):
    start = page * page_size
    end = min(start + page_size, len(enriched))
    total_pages = (len(enriched) + page_size - 1) // page_size

    table = Table(title=f"Page {page + 1} of {total_pages}  (findings {start + 1}-{end} of {len(enriched)})", show_lines=False)
    table.add_column("#", justify="right", style="bold", width=5)
    table.add_column("Severity", width=10)
    table.add_column("Scanner", width=9)
    table.add_column("Rule", width=30)
    table.add_column("File", width=28)
    table.add_column("Override", width=22)

    for i in range(start, end):
        f = enriched[i]
        color = SEVERITY_COLORS.get(f["severity"], "white")
        sev = Text(f["severity"], style=color)
        rule = f["rule"][:29]
        fname = f["file"].split("/")[-1][:27]
        ovr = f.get("override_label", "")
        table.add_row(str(i + 1), sev, f["tool"], rule, fname, ovr)

    return table


def show_detail(enriched, idx, source_dir):
    f = enriched[idx]
    console.print(f"\n[bold]🔍 Finding Detail — #{idx + 1}[/]")
    console.print(f"   Scanner:     {f['tool']}")
    console.print(f"   Rule:        {f['rule']}")
    console.print(f"   Severity:    [{SEVERITY_COLORS.get(f['severity'], 'white')}]{f['severity']}[/]")
    console.print(f"   File:        {f['file']}")
    console.print(f"   Line:        {f['line']}")
    console.print(f"   Description: {f['description']}")
    if f.get("override"):
        o = f["override"]
        console.print(f"   Override:    {o.get('disposition')} — {o.get('justification', '')[:80]}")
        console.print(f"   Expires:     {o.get('expires')}  Approved by: {o.get('approved_by', '').split('/')[-1]}")

    # Show source context if available
    if source_dir:
        src_file = Path(source_dir) / f["file"].lstrip("/").lstrip("./")
        if not src_file.exists():
            # Try without leading path components
            for candidate in Path(source_dir).rglob(Path(f["file"]).name):
                src_file = candidate
                break
        if src_file.exists():
            try:
                lines = src_file.read_text().splitlines()
                line_num = int(f["line"]) - 1
                start = max(0, line_num - 5)
                end = min(len(lines), line_num + 6)
                console.print(f"\n   [dim]Source context ({src_file.name}:{f['line']}):[/]")
                for i in range(start, end):
                    marker = ">>>" if i == line_num else "   "
                    console.print(f"   {marker} {i + 1:>4} | {lines[i]}")
            except Exception:
                pass
    console.print()


def interactive_loop(enriched, page_size, source_dir):
    page = 0
    total_pages = (len(enriched) + page_size - 1) // page_size

    while True:
        table = build_page_table(enriched, page, page_size)
        console.print(table)
        console.print("[dim][n]ext [p]rev [d N]etail [a N]i review [o N,N]verride [q]uit[/]")

        try:
            cmd = input("> ").strip().lower()
        except (KeyboardInterrupt, EOFError):
            console.print("\n   Cancelled")
            return None

        if cmd == "q":
            return None
        elif cmd == "n":
            if page < total_pages - 1:
                page += 1
        elif cmd == "p":
            if page > 0:
                page -= 1
        elif cmd.startswith("d "):
            try:
                idx = int(cmd[2:]) - 1
                if 0 <= idx < len(enriched):
                    show_detail(enriched, idx, source_dir)
                else:
                    console.print(f"[red]   Invalid index (1-{len(enriched)})[/]")
            except ValueError:
                console.print("[red]   Usage: d N[/]")
        elif cmd.startswith("a "):
            try:
                idx = int(cmd[2:]) - 1
                if 0 <= idx < len(enriched):
                    show_detail(enriched, idx, source_dir)
                    console.print("[bold cyan]   🤖 AI Review requested — analyze this finding in the conversation.[/]")
                    console.print("   The AI will read the source file and project context to recommend a classification.")
                    # Output finding as JSON for AI to pick up
                    f = enriched[idx]
                    clean = {k: v for k, v in f.items() if k not in ("override", "override_label", "sort_key")}
                    console.print("\n   [dim]Finding JSON for AI:[/]")
                    console.print(json.dumps(clean, indent=2))
                    return {"action": "ai_review", "finding": clean, "index": idx + 1}
                else:
                    console.print(f"[red]   Invalid index (1-{len(enriched)})[/]")
            except ValueError:
                console.print("[red]   Usage: a N[/]")
        elif cmd.startswith("o "):
            sel = cmd[2:]
            indices = _parse_selection(sel, len(enriched))
            selected = []
            for i in indices:
                f = enriched[i]
                if f.get("override"):
                    console.print(f"   [yellow]⚠️  #{i + 1} already overridden, skipping[/]")
                    continue
                clean = {k: v for k, v in f.items() if k not in ("override", "override_label", "sort_key")}
                selected.append(clean)
            if selected:
                console.print(f"\n   {len(selected)} finding(s) selected for override:")
                console.print(json.dumps(selected, indent=2))
                return {"action": "override", "findings": selected}
        else:
            console.print("[dim]   Commands: n, p, d N, a N, o N,N, q[/]")


def main():
    parser = argparse.ArgumentParser(description="SSDF Manager — Consolidated Scan Report")
    parser.add_argument("--profile", help="AWS profile override")
    parser.add_argument("--pipeline", help="Pipeline name (skip session file)")
    parser.add_argument("--limit", type=int, default=10, help="Max scan runs to display")
    parser.add_argument("--page-size", type=int, default=25, help="Findings per page (default: 25)")
    parser.add_argument("--select", help="Select findings by index and output JSON (non-interactive)")
    parser.add_argument("--no-cleanup", action="store_true", help="Keep temp/ after exit (debug)")
    args = parser.parse_args()

    session_data = load_session(args.profile, args.pipeline)
    bucket = session_data["artifact_bucket"]
    pipeline = session_data["pipeline_name"]
    s3 = boto3.Session(profile_name=session_data["profile_name"]).client("s3")

    # Step 1: Select scan run
    console.print(f"[bold]📂 Scan Runs — {pipeline}[/]\n")
    runs = list_scan_runs(s3, bucket, args.limit)
    if not runs:
        console.print("   No scan runs found.")
        return

    for i, run in enumerate(runs, 1):
        ts = run["last_modified"].strftime("%Y-%m-%d %H:%M") if hasattr(run["last_modified"], "strftime") else str(run["last_modified"])
        console.print(f"   {i}. v{run['version']}  ({ts})")

    console.print()
    try:
        choice = input("Select scan run number (or 'q' to quit): ").strip()
        if choice.lower() == "q":
            return
        idx = int(choice) - 1
        if idx < 0 or idx >= len(runs):
            console.print("[red]❌ Invalid selection[/]")
            return
    except (ValueError, KeyboardInterrupt):
        console.print("\n❌ Cancelled")
        return

    selected_run = runs[idx]
    ts = selected_run["last_modified"].strftime("%Y-%m-%d %H:%M") if hasattr(selected_run["last_modified"], "strftime") else ""

    # Step 2: Download source and reports
    console.print("\n⏳ Loading reports and overrides...")
    source_dir = download_source(s3, bucket, selected_run["prefix"], args.no_cleanup)

    report_keys = list_report_keys(s3, bucket, selected_run["prefix"])
    overrides = download_overrides(s3, bucket)
    by_id, by_key = build_override_index(overrides, pipeline)

    all_findings = []
    for key in report_keys:
        filename = key.split("/")[-1].lower()
        if not any(s in filename for s in SECURITY_SCANNERS):
            continue
        try:
            resp = s3.get_object(Bucket=bucket, Key=key)
            data = json.loads(resp["Body"].read().decode("utf-8"))
            all_findings.extend(detect_and_parse(data, key.split("/")[-1]))
        except Exception as e:
            console.print(f"   [yellow]⚠️  Failed to parse {key.split('/')[-1]}: {e}[/]")

    if not all_findings:
        console.print("   No security findings.")
        return

    # Step 3: Enrich and sort
    for f in all_findings:
        override = match_override(f, pipeline, by_id, by_key)
        f["override"] = override
        f["override_label"] = override_label(override)
        f["sort_key"] = (SEVERITY_ORDER.get(f["severity"], 99), 0 if not override else 1, f["tool"])
    all_findings.sort(key=lambda f: f["sort_key"])

    # Step 4: Summary
    build_summary_header(all_findings, selected_run["version"], ts)

    # Step 5: Non-interactive select mode
    if args.select:
        indices = _parse_selection(args.select, len(all_findings))
        selected = [all_findings[i] for i in indices if not all_findings[i].get("override")]
        for f in selected:
            for k in ("override", "override_label", "sort_key"):
                f.pop(k, None)
        json.dump(selected, sys.stdout, indent=2)
        print()
        return

    # Step 6: Interactive paginated view
    result = interactive_loop(all_findings, args.page_size, source_dir)
    if result:
        console.print(f"\n[bold]Action: {result['action']}[/]")


if __name__ == "__main__":
    main()
