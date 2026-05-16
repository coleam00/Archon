#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""Parse scanner reports and display findings for review and selection."""

import argparse
import json
import sys
from pathlib import Path

import boto3

SESSION_FILE = Path(__file__).resolve().parent.parent / ".session.json"


def load_session(profile_override=None, pipeline_override=None):
    """Load session, or build one on the fly from --profile + --pipeline."""
    if profile_override and pipeline_override:
        session = boto3.Session(profile_name=profile_override)
        sts = session.client("sts")
        identity = sts.get_caller_identity()
        account_id = identity["Account"]
        region = session.region_name or "us-east-1"
        return {
            "profile_name": profile_override,
            "account_id": account_id,
            "region": region,
            "arn": identity["Arn"],
            "pipeline_name": pipeline_override,
            "artifact_bucket": f"{pipeline_override}-artifacts-{account_id}-{region}",
        }
    if not SESSION_FILE.exists():
        print("❌ No session found. Run select-profile.py first, or pass --profile and --pipeline.", file=sys.stderr)
        sys.exit(1)
    with open(SESSION_FILE) as f:
        session = json.load(f)
    if profile_override:
        session["profile_name"] = profile_override
    return session


def parse_semgrep(data):
    """Parse semgrep JSON results."""
    findings = []
    for r in data.get("results", []):
        findings.append({
            "tool": "semgrep",
            "rule": r.get("check_id", "unknown"),
            "file": r.get("path", "unknown"),
            "line": str(r.get("start", {}).get("line", 0)),
            "severity": r.get("extra", {}).get("severity", "UNKNOWN").upper(),
            "description": r.get("extra", {}).get("message", "")[:200],
        })
    return findings


def parse_kics(data):
    """Parse kics JSON results."""
    findings = []
    for query in data.get("queries", []):
        rule = query.get("query_name", query.get("query_id", "unknown"))
        severity = query.get("severity", "UNKNOWN").upper()
        desc = query.get("description", "")[:200]
        for f in query.get("files", []):
            findings.append({
                "tool": "kics",
                "rule": rule,
                "file": f.get("file_name", "unknown"),
                "line": str(f.get("line", 0)),
                "severity": severity,
                "description": desc,
            })
    return findings


def parse_trivy(data):
    """Parse trivy JSON results."""
    findings = []
    for result in data.get("Results", []):
        target = result.get("Target", "unknown")
        for vuln in result.get("Vulnerabilities", []):
            findings.append({
                "tool": "trivy",
                "rule": vuln.get("VulnerabilityID", "unknown"),
                "file": target,
                "line": "0",
                "severity": vuln.get("Severity", "UNKNOWN").upper(),
                "description": vuln.get("Title", "")[:200],
            })
        for misconfig in result.get("Misconfigurations", []):
            findings.append({
                "tool": "trivy",
                "rule": misconfig.get("ID", "unknown"),
                "file": target,
                "line": "0",
                "severity": misconfig.get("Severity", "UNKNOWN").upper(),
                "description": misconfig.get("Title", "")[:200],
            })
    return findings


def parse_checkov(data):
    """Parse checkov JSON results."""
    findings = []
    results = data.get("results", {})
    for check in results.get("failed_checks", []):
        findings.append({
            "tool": "checkov",
            "rule": check.get("check_id", "unknown"),
            "file": check.get("file_path", "unknown"),
            "line": str(check.get("file_line_range", [0])[0]),
            "severity": check.get("severity", "UNKNOWN").upper() if check.get("severity") else "MEDIUM",
            "description": check.get("check_name", "")[:200],
        })
    return findings


def parse_gitleaks(data):
    """Parse gitleaks JSON results."""
    findings = []
    if not isinstance(data, list):
        return findings
    for leak in data:
        findings.append({
            "tool": "gitleaks",
            "rule": leak.get("RuleID", "unknown"),
            "file": leak.get("File", "unknown"),
            "line": str(leak.get("StartLine", 0)),
            "severity": "HIGH",
            "description": leak.get("Description", leak.get("Match", ""))[:200],
        })
    return findings


def detect_and_parse(data):
    """Auto-detect scanner format and parse."""
    if isinstance(data, list):
        # Gitleaks returns a top-level array
        return parse_gitleaks(data)
    if "results" in data and isinstance(data["results"], list) and data["results"] and "check_id" in data["results"][0]:
        return parse_semgrep(data)
    if "queries" in data:
        return parse_kics(data)
    if "Results" in data:
        return parse_trivy(data)
    if "results" in data and isinstance(data["results"], dict) and "failed_checks" in data["results"]:
        return parse_checkov(data)
    # Fallback: try semgrep format
    if "results" in data:
        return parse_semgrep(data)
    print("⚠️  Unknown scanner format. Could not parse findings.", file=sys.stderr)
    return []


def parse_selection(selection_str, max_index):
    """Parse selection like '1,3,5-7' into list of 0-based indices."""
    indices = []
    for part in selection_str.split(","):
        part = part.strip()
        if "-" in part:
            try:
                start, end = part.split("-", 1)
                for i in range(int(start), int(end) + 1):
                    if 1 <= i <= max_index:
                        indices.append(i - 1)
                    else:
                        print(f"⚠️  Index {i} out of range (1-{max_index}), skipping", file=sys.stderr)
            except ValueError:
                print(f"⚠️  Invalid range '{part}', skipping", file=sys.stderr)
        else:
            try:
                i = int(part)
                if 1 <= i <= max_index:
                    indices.append(i - 1)
                else:
                    print(f"⚠️  Index {i} out of range (1-{max_index}), skipping", file=sys.stderr)
            except ValueError:
                print(f"⚠️  Invalid index '{part}', skipping", file=sys.stderr)
    return sorted(set(indices))


def main():
    parser = argparse.ArgumentParser(description="SSDF Manager — Review Findings")
    parser.add_argument("--profile", help="AWS profile override")
    parser.add_argument("--pipeline", help="Pipeline name (skip session file)")
    parser.add_argument("--bucket", help="S3 bucket (default: from session)")
    parser.add_argument("--key", required=True, help="S3 key of scanner report JSON")
    parser.add_argument("--detail", type=int, help="Show full detail for finding at index N")
    parser.add_argument("--select", help="Select findings by index (e.g., 1,3,5-7) and output as JSON")
    args = parser.parse_args()

    session_data = load_session(args.profile, args.pipeline)
    bucket = args.bucket or session_data.get("artifact_bucket")
    if not bucket:
        print("❌ No bucket specified. Use --bucket or run select-profile.py first.", file=sys.stderr)
        sys.exit(1)

    # Download report from S3
    s3 = boto3.Session(profile_name=session_data["profile_name"]).client("s3")
    try:
        resp = s3.get_object(Bucket=bucket, Key=args.key)
        data = json.loads(resp["Body"].read().decode("utf-8"))
    except s3.exceptions.NoSuchKey:
        print(f"❌ Report not found: s3://{bucket}/{args.key}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"❌ Failed to download report: {e}", file=sys.stderr)
        sys.exit(1)

    findings = detect_and_parse(data)
    if not findings:
        print("   No findings in this report.")
        return

    # Detail mode
    if args.detail is not None:
        idx = args.detail - 1
        if idx < 0 or idx >= len(findings):
            print(f"❌ Index {args.detail} out of range (1-{len(findings)})", file=sys.stderr)
            sys.exit(1)
        f = findings[idx]
        print(f"🔍 Finding Detail — #{args.detail}")
        print(f"   Tool:        {f['tool']}")
        print(f"   Rule:        {f['rule']}")
        print(f"   File:        {f['file']}")
        print(f"   Line:        {f['line']}")
        print(f"   Severity:    {f['severity']}")
        print(f"   Description: {f['description']}")
        return

    # Selection mode — output JSON to stdout
    if args.select:
        indices = parse_selection(args.select, len(findings))
        selected = [findings[i] for i in indices]
        json.dump(selected, sys.stdout, indent=2)
        print()
        return

    # Display table
    report_name = args.key.split("/")[-1]
    print(f"🔍 Findings — {report_name}")
    print(f"   Total: {len(findings)}")
    print()
    print(f"{'#':>3}  {'Tool':<10} {'Severity':<10} {'Rule':<35} {'File':<30}")
    print(f"{'─'*3}  {'─'*10} {'─'*10} {'─'*35} {'─'*30}")
    for i, f in enumerate(findings, 1):
        rule = f["rule"][:34]
        file = f["file"][:29]
        print(f"{i:>3}  {f['tool']:<10} {f['severity']:<10} {rule:<35} {file:<30}")

    print("\n💡 Commands:")
    print("   Detail:  --detail N")
    print("   Select:  --select '1,3,5-7' (outputs JSON for manage-overrides.py)")


if __name__ == "__main__":
    main()
