#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""Generate and manage .ssdf-context.json for project context persistence."""

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import boto3

SESSION_FILE = Path(__file__).resolve().parent.parent / ".session.json"
CONTEXT_FILE = Path(__file__).resolve().parent.parent / ".ssdf-context.json"
OVERRIDES_KEY = "manifests/finding-overrides.json"


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
        print("❌ No session found. Run select-profile.py first.", file=sys.stderr)
        sys.exit(1)
    with open(SESSION_FILE) as f:
        session = json.load(f)
    if not session.get("pipeline_name"):
        print("❌ No pipeline configured.", file=sys.stderr)
        sys.exit(1)
    if profile_override:
        session["profile_name"] = profile_override
    return session


def compute_source_hash(source_dir):
    """SHA-256 of all file contents in source directory for change detection."""
    h = hashlib.sha256()
    for path in sorted(Path(source_dir).rglob("*")):
        if path.is_file():
            h.update(path.read_bytes())
    return f"sha256:{h.hexdigest()}"


def scan_templates(source_dir):
    """Scan CFN/IaC templates and extract architecture summary."""
    templates = []
    resource_types = set()
    compensating_controls = []
    encryption_items = []
    network_items = []

    for path in sorted(Path(source_dir).rglob("*")):
        if not path.is_file():
            continue
        if path.suffix not in (".yml", ".yaml", ".json", ".tf"):
            continue
        # Skip non-IaC files
        try:
            content = path.read_text(errors="ignore")
        except Exception:
            continue

        # Detect CFN templates
        if "AWSTemplateFormatVersion" in content or "AWS::" in content:
            templates.append(str(path.relative_to(source_dir)))
            # Extract resource types
            for match in re.findall(r"Type:\s*['\"]?(AWS::\w+::\w+)", content):
                resource_types.add(match.split("::")[-1])
            # Detect encryption
            if "KmsKeyId" in content or "SSEAlgorithm" in content or "EncryptionConfiguration" in content:
                encryption_items.append(f"KMS/SSE encryption in {path.name}")
            # Detect network controls
            if "SecurityGroup" in content:
                network_items.append(f"Security groups defined in {path.name}")
            if "AWS::EC2::NetworkAcl" in content:
                compensating_controls.append(f"NACLs defined in {path.name}")
            # Detect SCP references
            if "scp" in content.lower() or "ServiceControlPolicy" in content:
                compensating_controls.append("SCP references found in templates")

    # Summarize encryption posture
    encryption_posture = "KMS encryption detected" if encryption_items else "No KMS encryption detected in templates"
    network_isolation = "VPC with security groups" if network_items else "No VPC configuration detected"

    return {
        "templates": templates,
        "resource_types": sorted(resource_types),
        "compensating_controls": list(set(compensating_controls)),
        "encryption_posture": encryption_posture,
        "network_isolation": network_isolation,
    }


def get_review_history(s3, bucket):
    """Get override count from S3."""
    try:
        resp = s3.get_object(Bucket=bucket, Key=OVERRIDES_KEY)
        data = json.loads(resp["Body"].read().decode("utf-8"))
        return len(data.get("overrides", []))
    except Exception:
        return 0


def generate_context(source_dir, session_data, s3, scan_version="unknown", finding_count=0):
    """Generate project context from source directory."""
    source_hash = compute_source_hash(source_dir)
    architecture = scan_templates(source_dir)
    override_count = get_review_history(s3, session_data["artifact_bucket"])

    context = {
        "project_name": session_data["pipeline_name"],
        "source_hash": source_hash,
        "last_reviewed": datetime.now(timezone.utc).isoformat(),
        "architecture": architecture,
        "review_history": {
            "last_scan_version": scan_version,
            "total_findings": finding_count,
            "overridden": override_count,
            "reviewed_by_ai": 0,
        },
    }
    return context


def save_context(context):
    """Save context with 0600 permissions."""
    with open(CONTEXT_FILE, "w") as f:
        json.dump(context, f, indent=2)
    if sys.platform != "win32":
        os.chmod(CONTEXT_FILE, 0o600)


def load_context():
    """Load existing context or return None."""
    if CONTEXT_FILE.exists():
        with open(CONTEXT_FILE) as f:
            return json.load(f)
    return None


def should_refresh(source_dir, existing_context):
    """Check if context needs regeneration based on source hash."""
    if not existing_context:
        return True
    current_hash = compute_source_hash(source_dir)
    return current_hash != existing_context.get("source_hash")


def main():
    parser = argparse.ArgumentParser(description="SSDF Manager — Project Context Generator")
    parser.add_argument("--profile", help="AWS profile override")
    parser.add_argument("--pipeline", help="Pipeline name")
    parser.add_argument("--source-dir", required=True, help="Path to extracted source directory")
    parser.add_argument("--scan-version", default="unknown", help="Scan version string")
    parser.add_argument("--finding-count", type=int, default=0, help="Total finding count from scan")
    parser.add_argument("--refresh", action="store_true", help="Force regeneration")
    args = parser.parse_args()

    session_data = load_session(args.profile, args.pipeline)
    s3 = boto3.Session(profile_name=session_data["profile_name"]).client("s3")

    existing = load_context()

    if existing and not args.refresh:
        if not should_refresh(args.source_dir, existing):
            print("✅ Context unchanged (hash match) — reusing existing context")
            print(f"   Project: {existing['project_name']}")
            print(f"   Templates: {len(existing['architecture']['templates'])}")
            print(f"   Last reviewed: {existing['last_reviewed']}")
            # Update review history counts
            existing["review_history"]["last_scan_version"] = args.scan_version
            existing["review_history"]["total_findings"] = args.finding_count
            existing["review_history"]["overridden"] = get_review_history(s3, session_data["artifact_bucket"])
            save_context(existing)
            return

    print("🔍 Scanning source for project context...")
    context = generate_context(args.source_dir, session_data, s3, args.scan_version, args.finding_count)
    save_context(context)

    arch = context["architecture"]
    print("✅ Context generated and saved")
    print(f"   Project:    {context['project_name']}")
    print(f"   Templates:  {len(arch['templates'])}")
    print(f"   Resources:  {', '.join(arch['resource_types'][:10])}")
    print(f"   Encryption: {arch['encryption_posture']}")
    print(f"   Network:    {arch['network_isolation']}")
    print(f"   Controls:   {len(arch['compensating_controls'])} compensating controls detected")
    print(f"   Saved to:   {CONTEXT_FILE}")


if __name__ == "__main__":
    main()
