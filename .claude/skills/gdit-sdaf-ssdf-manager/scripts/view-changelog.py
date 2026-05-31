#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""Query CloudWatch audit log for finding override change history."""

import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import boto3

SESSION_FILE = Path(__file__).resolve().parent.parent / ".session.json"


def load_session(profile_override=None, pipeline_override=None):
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
    if not session.get("pipeline_name"):
        print("❌ No pipeline configured. Run select-profile.py first, or pass --pipeline.", file=sys.stderr)
        sys.exit(1)
    if profile_override:
        session["profile_name"] = profile_override
    return session


def main():
    parser = argparse.ArgumentParser(description="SSDF Manager — View Override Change Log")
    parser.add_argument("--profile", help="AWS profile override")
    parser.add_argument("--pipeline", help="Pipeline name (skip session file)")
    parser.add_argument("--days", type=int, default=30, help="Query window in days (default: 30)")
    parser.add_argument("--limit", type=int, default=50, help="Max results (default: 50)")
    args = parser.parse_args()

    session_data = load_session(args.profile, args.pipeline)
    pipeline = session_data["pipeline_name"]
    log_group = f"/aws/security-hub/{pipeline}/finding-overrides"

    print(f"📜 Override Change Log — {pipeline}")
    print(f"   Log group: {log_group}")
    print(f"   Window: last {args.days} days")
    print()

    logs = boto3.Session(profile_name=session_data["profile_name"]).client("logs")

    end_time = int(datetime.now(timezone.utc).timestamp())
    start_time = int((datetime.now(timezone.utc) - timedelta(days=args.days)).timestamp())

    query = (
        "fields @timestamp, event_type, tool, rule, file, disposition, approved_by\n"
        "| sort @timestamp desc\n"
        f"| limit {args.limit}"
    )

    try:
        resp = logs.start_query(
            logGroupName=log_group,
            startTime=start_time,
            endTime=end_time,
            queryString=query,
        )
    except Exception as e:
        if "ResourceNotFoundException" in str(e):
            print(f"   ❌ Log group {log_group} does not exist.")
            print("   Create it in the pipeline CFN stack or manually:")
            print(f"   aws logs create-log-group --log-group-name '{log_group}' --retention-in-days 365")
            return
        raise

    query_id = resp["queryId"]
    print("   Querying...", end="", flush=True)

    # Poll for results
    for _ in range(30):
        time.sleep(1)
        result = logs.get_query_results(queryId=query_id)
        if result["status"] == "Complete":
            break
        print(".", end="", flush=True)
    print()

    results = result.get("results", [])
    if not results:
        print("   No override changes found in this window.")
        return

    print(f"\n{'Timestamp':<22} {'Event':<8} {'Tool':<10} {'Rule':<25} {'File':<25} {'Disposition':<16} {'Approved By'}")
    print(f"{'─'*22} {'─'*8} {'─'*10} {'─'*25} {'─'*25} {'─'*16} {'─'*20}")

    for row in results:
        fields = {f["field"]: f["value"] for f in row}
        ts = fields.get("@timestamp", "")[:21]
        event = fields.get("event_type", "")[:7]
        tool = fields.get("tool", "")[:9]
        rule = fields.get("rule", "")[:24]
        file = fields.get("file", "")[:24]
        disp = fields.get("disposition", "")[:15]
        approver = fields.get("approved_by", "").split("/")[-1][:19]
        print(f"{ts:<22} {event:<8} {tool:<10} {rule:<25} {file:<25} {disp:<16} {approver}")

    print(f"\n   Total: {len(results)} event(s)")


if __name__ == "__main__":
    main()
