#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
Security Hub Finding Scope Selector and Severity-Grouped Reporter

Implements:
- Task 18: Source Discovery and Classification
- Task 17: Finding Scope Selector
- Task 19: Severity-First Grouped Reporting

Usage:
  # Discover sources
  python3 discover-and-report.py --profile SPP1 discover

  # Report with scope
  python3 discover-and-report.py --profile SPP1 report --scope all
  python3 discover-and-report.py --profile SPP1 report --scope aws
  python3 discover-and-report.py --profile SPP1 report --scope pipelines
  python3 discover-and-report.py --profile SPP1 report --scope "HCOM Release Pipeline"
"""

import argparse
import json
import re
from collections import defaultdict
from datetime import datetime, timezone

import boto3

# --- Task 18: Source Discovery and Classification ---

AWS_PRODUCT_PREFIX = "arn:aws:securityhub:{region}::product/aws/"
DEFAULT_PRODUCT_PATTERN = re.compile(
    r"^arn:aws:securityhub:[^:]+:\d+:product/\d+/default$"
)
AWS_PRODUCT_PATTERN = re.compile(
    r"^arn:aws:securityhub:[^:]+::product/aws/"
)

SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFORMATIONAL"]
DEFAULT_WORKFLOW_STATUSES = ["NEW", "NOTIFIED"]


def classify_source(product_arn: str) -> str:
    """Classify a finding source by its ProductArn pattern."""
    if AWS_PRODUCT_PATTERN.match(product_arn):
        return "AWS Service"
    if DEFAULT_PRODUCT_PATTERN.match(product_arn):
        return "Pipeline"
    return "Integration"


def discover_sources(client: object) -> dict:
    """Query Security Hub for distinct sources across active findings.

    Returns dict keyed by ProductName with classification and count.
    """
    paginator = client.get_paginator("get_findings")
    filters = {
        "RecordState": [{"Value": "ACTIVE", "Comparison": "EQUALS"}],
        "WorkflowStatus": [
            {"Value": s, "Comparison": "EQUALS"}
            for s in DEFAULT_WORKFLOW_STATUSES
        ],
    }

    sources: dict[str, dict] = {}
    for page in paginator.paginate(Filters=filters):
        for f in page.get("Findings", []):
            product_arn = f["ProductArn"]
            product_name = f.get("ProductName", "Unknown")
            key = product_name
            if key not in sources:
                sources[key] = {
                    "product_name": product_name,
                    "product_arn": product_arn,
                    "company": f.get("CompanyName", ""),
                    "category": classify_source(product_arn),
                    "count": 0,
                }
            sources[key]["count"] += 1

    return sources


# --- Task 17: Finding Scope Selector ---


def build_scope_filter(scope: str, sources: dict, region: str, account_id: str) -> dict:
    """Build Security Hub filter criteria for the selected scope."""
    base = {
        "RecordState": [{"Value": "ACTIVE", "Comparison": "EQUALS"}],
        "WorkflowStatus": [
            {"Value": s, "Comparison": "EQUALS"}
            for s in DEFAULT_WORKFLOW_STATUSES
        ],
    }

    if scope == "all":
        return base

    if scope == "aws":
        base["ProductArn"] = [
            {
                "Value": f"arn:aws:securityhub:{region}::product/aws/",
                "Comparison": "PREFIX",
            }
        ]
        return base

    if scope == "pipelines":
        base["ProductArn"] = [
            {
                "Value": f"arn:aws:securityhub:{region}:{account_id}:product/{account_id}/default",
                "Comparison": "EQUALS",
            }
        ]
        return base

    # Specific source by ProductName
    if scope in sources:
        src = sources[scope]
        if src["category"] == "Pipeline":
            base["ProductArn"] = [
                {"Value": src["product_arn"], "Comparison": "EQUALS"}
            ]
            base["ProductName"] = [
                {"Value": scope, "Comparison": "EQUALS"}
            ]
        else:
            base["ProductArn"] = [
                {"Value": src["product_arn"], "Comparison": "EQUALS"}
            ]
        return base

    # Fallback: treat as ProductName filter
    base["ProductName"] = [{"Value": scope, "Comparison": "EQUALS"}]
    return base


# --- Task 19: Severity-First Grouped Reporting ---


def fetch_findings(client: object, filters: dict) -> list[dict]:
    """Fetch all findings matching the filter."""
    paginator = client.get_paginator("get_findings")
    findings = []
    for page in paginator.paginate(Filters=filters):
        findings.extend(page.get("Findings", []))
    return findings


def group_findings(findings: list[dict]) -> dict:
    """Group findings by severity, then by source (ProductName)."""
    grouped: dict[str, dict[str, list]] = {s: defaultdict(list) for s in SEVERITY_ORDER}

    for f in findings:
        severity = f.get("Severity", {}).get("Label", "INFORMATIONAL")
        if severity not in grouped:
            severity = "INFORMATIONAL"
        source = f.get("ProductName", "Unknown")
        grouped[severity][source].append(f)

    return grouped


def finding_age_days(finding: dict) -> int:
    """Calculate finding age in days from FirstObservedAt."""
    first = finding.get("FirstObservedAt", finding.get("CreatedAt", ""))
    if not first:
        return 0
    try:
        dt = datetime.fromisoformat(first.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - dt).days
    except (ValueError, TypeError):
        return 0


def finding_summary(finding: dict) -> str:
    """One-line summary of a finding."""
    title = finding.get("Title", "No title")
    resources = finding.get("Resources", [])
    resource_id = ""
    if resources:
        rid = resources[0].get("Id", "")
        # Shorten ARN to last meaningful segment
        parts = rid.split("/")
        resource_id = parts[-1] if len(parts) > 1 else rid
        if len(resource_id) > 40:
            resource_id = resource_id[:20] + "..." + resource_id[-8:]
    age = finding_age_days(finding)
    parts = [title]
    if resource_id:
        parts.append(resource_id)
    parts.append(f"{age}d")
    return " | ".join(parts)


def render_report(grouped: dict, scope: str, profile: str, account_id: str) -> str:
    """Render the severity-first grouped report as text."""
    total = sum(
        len(f) for sev in grouped.values() for f in sev.values()
    )
    severity_counts = []
    for sev in SEVERITY_ORDER:
        count = sum(len(fs) for fs in grouped[sev].values())
        if count:
            severity_counts.append(f"{count} {sev}")

    lines = [
        "═══ Security Hub Findings Report ═══",
        f"Profile: {profile} | Account: ****{account_id[-4:]} | Scope: {scope}",
        f"Total: {total} findings ({', '.join(severity_counts)})",
        "",
    ]

    finding_num = 0
    for sev in SEVERITY_ORDER:
        sources = grouped[sev]
        sev_count = sum(len(fs) for fs in sources.values())
        if sev_count == 0:
            continue

        lines.append(f"── {sev} ({sev_count}) {'─' * (50 - len(sev))}")

        for source_name in sorted(sources.keys()):
            source_findings = sources[source_name]
            # Sort by FirstObservedAt descending (newest first)
            source_findings.sort(
                key=lambda f: f.get("FirstObservedAt", ""), reverse=True
            )
            lines.append(f"  {source_name} ({len(source_findings)})")
            for f in source_findings:
                finding_num += 1
                lines.append(f"    {finding_num}. {finding_summary(f)}")
            lines.append("")

    return "\n".join(lines)


# --- CLI ---


def cmd_discover(args):
    """Discover and display all finding sources."""
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    client = session.client("securityhub")
    account_id = session.client("sts").get_caller_identity()["Account"]

    sources = discover_sources(client)
    if not sources:
        print("No active findings found.")
        return

    aws_sources = {k: v for k, v in sources.items() if v["category"] == "AWS Service"}
    pipeline_sources = {k: v for k, v in sources.items() if v["category"] == "Pipeline"}

    total = sum(s["count"] for s in sources.values())
    print(f"Account: ****{account_id[-4:]} | Total active findings: {total}\n")

    print("Scope Options:")
    print(f"  [1] All Sources ({total} findings)")

    aws_count = sum(s["count"] for s in aws_sources.values())
    if aws_sources:
        names = ", ".join(sorted(aws_sources.keys()))
        print(f"  [2] AWS Services ({aws_count} findings) — {names}")

    pipe_count = sum(s["count"] for s in pipeline_sources.values())
    if pipeline_sources:
        names = ", ".join(sorted(pipeline_sources.keys()))
        print(f"  [3] Pipelines ({pipe_count} findings) — {names}")

    idx = 4
    for name in sorted(sources.keys()):
        info = sources[name]
        print(f"  [{idx}] {name} ({info['count']} findings) [{info['category']}]")
        idx += 1

    if args.json:
        print("\n" + json.dumps(sources, indent=2, default=str))


def cmd_report(args):
    """Generate severity-first grouped report."""
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    client = session.client("securityhub")
    account_id = session.client("sts").get_caller_identity()["Account"]

    sources = discover_sources(client)
    filters = build_scope_filter(args.scope, sources, args.region, account_id)
    findings = fetch_findings(client, filters)

    if not findings:
        print(f"No findings for scope: {args.scope}")
        return

    grouped = group_findings(findings)
    report = render_report(grouped, args.scope, args.profile, account_id)
    print(report)

    if args.json:
        output = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "profile": args.profile,
            "account_id": f"****{account_id[-4:]}",
            "scope": args.scope,
            "total": len(findings),
            "by_severity": {
                sev: {
                    src: len(fs)
                    for src, fs in grouped[sev].items()
                }
                for sev in SEVERITY_ORDER
                if any(grouped[sev].values())
            },
        }
        print("\n" + json.dumps(output, indent=2))


def main():
    parser = argparse.ArgumentParser(
        description="Security Hub Finding Scope Selector and Severity-Grouped Reporter"
    )
    parser.add_argument("--profile", required=True, help="AWS CLI profile name")
    parser.add_argument("--region", default="us-east-1", help="AWS region")
    parser.add_argument("--json", action="store_true", help="Include JSON output")

    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("discover", help="Discover finding sources")

    report_parser = sub.add_parser("report", help="Generate grouped report")
    report_parser.add_argument(
        "--scope",
        default="all",
        help="Scope: all, aws, pipelines, or a specific ProductName",
    )

    args = parser.parse_args()

    if args.command == "discover":
        cmd_discover(args)
    elif args.command == "report":
        cmd_report(args)


if __name__ == "__main__":
    main()
