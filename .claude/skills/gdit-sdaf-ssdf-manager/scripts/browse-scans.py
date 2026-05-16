#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""Browse pipeline scan runs and scanner reports from S3."""

import argparse
import json
import sys
from datetime import datetime, timezone
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
        print("❌ No session found. Run select-profile.py first, or pass --profile and --pipeline.")
        sys.exit(1)
    with open(SESSION_FILE) as f:
        session = json.load(f)
    if not session.get("pipeline_name"):
        print("❌ No pipeline configured in session. Run select-profile.py first, or pass --pipeline.")
        sys.exit(1)
    if profile_override:
        session["profile_name"] = profile_override
    return session


def list_scan_runs(s3, bucket, pipeline_name=None, limit=10):
    """List scan runs from the artifact bucket."""
    runs = []
    paginator = s3.get_paginator("list_objects_v2")
    # Structure: runs/{version}/{pipeline}-security-validation:{build-id}/
    # First list version prefixes under runs/
    for page in paginator.paginate(Bucket=bucket, Prefix="runs/", Delimiter="/"):
        for prefix in page.get("CommonPrefixes", []):
            version = prefix["Prefix"].replace("runs/", "").rstrip("/")
            # List build-id prefixes under this version
            for vpage in paginator.paginate(Bucket=bucket, Prefix=prefix["Prefix"], Delimiter="/"):
                for build_prefix in vpage.get("CommonPrefixes", []):
                    bp = build_prefix["Prefix"]
                    if "security-validation" in bp:
                        # Get timestamp from any object in this prefix
                        try:
                            resp = s3.list_objects_v2(Bucket=bucket, Prefix=bp, MaxKeys=1)
                            if resp.get("KeyCount", 0) > 0:
                                last_mod = resp["Contents"][0].get("LastModified", datetime.min.replace(tzinfo=timezone.utc))
                                build_id = bp.rstrip("/").split(":")[-1][:8] if ":" in bp else ""
                                runs.append({"version": version, "prefix": bp, "last_modified": last_mod, "build_id": build_id})
                        except Exception:
                            continue
    runs.sort(key=lambda r: r["last_modified"], reverse=True)
    return runs[:limit]


def list_reports(s3, bucket, prefix):
    """List scanner report JSON files in a scan run."""
    reports = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            filename = key.split("/")[-1]
            if filename.endswith(".json") and ("report" in filename.lower() or "results" in filename.lower()):
                reports.append({"key": key, "filename": filename, "size": obj.get("Size", 0)})
    return reports


def main():
    parser = argparse.ArgumentParser(description="SSDF Manager — Browse Scan Runs")
    parser.add_argument("--profile", help="AWS profile override")
    parser.add_argument("--pipeline", help="Pipeline name (skip session file)")
    parser.add_argument("--limit", type=int, default=10, help="Max scan runs to display (default: 10)")
    args = parser.parse_args()

    session_data = load_session(args.profile, args.pipeline)
    bucket = session_data["artifact_bucket"]
    pipeline = session_data["pipeline_name"]

    print(f"📂 Scan Runs — {pipeline}")
    print()

    s3 = boto3.Session(profile_name=session_data["profile_name"]).client("s3")
    runs = list_scan_runs(s3, bucket, args.limit)

    if not runs:
        print("   No scan runs found with security-validation reports.")
        print("   Ensure the pipeline has completed at least one security scan.")
        return

    for i, run in enumerate(runs, 1):
        ts = run["last_modified"].strftime("%Y-%m-%d %H:%M") if hasattr(run["last_modified"], "strftime") else str(run["last_modified"])
        print(f"   {i}. v{run['version']}  ({ts})")

    print()
    try:
        choice = input("Select scan run number (or 'q' to quit): ").strip()
        if choice.lower() == "q":
            return
        idx = int(choice) - 1
        if idx < 0 or idx >= len(runs):
            print("❌ Invalid selection")
            return
    except (ValueError, KeyboardInterrupt):
        print("\n❌ Cancelled")
        return

    selected = runs[idx]
    print(f"\n📄 Reports in {selected['version']}/security-validation/")
    print()

    reports = list_reports(s3, bucket, selected["prefix"])
    if not reports:
        print("   No scanner report JSON files found.")
        return

    for i, r in enumerate(reports, 1):
        size_kb = r["size"] / 1024
        print(f"   {i}. {r['filename']} ({size_kb:.1f} KB)")

    print("\n💡 To review findings, use:")
    print(f"   python3 scripts/review-findings.py --bucket {bucket} --key <report-s3-key>")
    # Output report keys for easy copy
    print("\n📋 Report S3 keys:")
    for r in reports:
        print(f"   {r['key']}")


if __name__ == "__main__":
    main()
