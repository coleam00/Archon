#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""CRUD operations on finding-overrides.json with Security Hub suppression and audit logging."""

import argparse
import hashlib
import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import boto3

SESSION_FILE = Path(__file__).resolve().parent.parent / ".session.json"
OVERRIDES_KEY = "manifests/finding-overrides.json"


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


def get_identity(session_data):
    sts = boto3.Session(profile_name=session_data["profile_name"]).client("sts")
    return sts.get_caller_identity()["Arn"]


def get_partition(region):
    return "aws-us-gov" if region.startswith("us-gov-") else "aws"


def generate_finding_id(pipeline_name, tool, rule, file, line):
    raw = f"{tool}|{rule}|{file}|{line}"
    return f"{pipeline_name}/{hashlib.sha256(raw.encode()).hexdigest()}"


def download_overrides(s3, bucket):
    try:
        resp = s3.get_object(Bucket=bucket, Key=OVERRIDES_KEY)
        return json.loads(resp["Body"].read().decode("utf-8"))
    except s3.exceptions.NoSuchKey:
        return {"version": "1.0", "overrides": []}
    except Exception as e:
        if "NoSuchKey" in str(e) or "404" in str(e):
            return {"version": "1.0", "overrides": []}
        raise


def upload_overrides(s3, bucket, data):
    s3.put_object(
        Bucket=bucket,
        Key=OVERRIDES_KEY,
        Body=json.dumps(data, indent=2).encode("utf-8"),
        ContentType="application/json",
    )


def suppress_finding(session_data, finding_id, disposition, justification, expires):
    region = session_data["region"]
    account_id = session_data["account_id"]
    partition = get_partition(region)
    product_arn = f"arn:{partition}:securityhub:{region}:{account_id}:product/{account_id}/default"

    sh = boto3.Session(profile_name=session_data["profile_name"]).client("securityhub")
    try:
        resp = sh.batch_update_findings(
            FindingIdentifiers=[{"Id": finding_id, "ProductArn": product_arn}],
            Workflow={"Status": "SUPPRESSED"},
            Note={
                "Text": f"{disposition}: {justification} (expires: {expires})",
                "UpdatedBy": "ssdf-manager",
            },
        )
        unprocessed = resp.get("UnprocessedFindings", [])
        if unprocessed:
            print("   ⚠️  Finding not found in Security Hub (may already be resolved)")
        else:
            print("   ✅ Security Hub finding suppressed")
    except Exception as e:
        print(f"   ⚠️  Security Hub suppression failed: {e}")


def log_audit_event(session_data, event):
    pipeline = session_data["pipeline_name"]
    log_group = f"/aws/security-hub/{pipeline}/finding-overrides"
    stream_name = date.today().isoformat()

    logs = boto3.Session(profile_name=session_data["profile_name"]).client("logs")
    try:
        logs.create_log_stream(logGroupName=log_group, logStreamName=stream_name)
    except logs.exceptions.ResourceAlreadyExistsException:
        pass
    except Exception as e:
        if "ResourceNotFoundException" in str(e):
            print(f"   ⚠️  Log group {log_group} does not exist. Create it in the pipeline CFN stack.")
            return
        raise

    try:
        logs.put_log_events(
            logGroupName=log_group,
            logStreamName=stream_name,
            logEvents=[{
                "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
                "message": json.dumps(event),
            }],
        )
        print(f"   ✅ Audit event logged to {log_group}")
    except Exception as e:
        print(f"   ⚠️  Audit logging failed: {e}")


def expiration_status(expires_str):
    try:
        exp = date.fromisoformat(expires_str)
        days_left = (exp - date.today()).days
        if days_left < 0:
            return "❌ expired"
        if days_left <= 30:
            return f"⚠️  {days_left}d left"
        return "✅ active"
    except (ValueError, TypeError):
        return "❓ invalid"


def cmd_list(args, session_data):
    s3 = boto3.Session(profile_name=session_data["profile_name"]).client("s3")
    data = download_overrides(s3, session_data["artifact_bucket"])
    overrides = data.get("overrides", [])

    if not overrides:
        print("   No overrides configured.")
        return

    print(f"📋 Finding Overrides — {session_data['pipeline_name']}")
    print(f"   File: s3://{session_data['artifact_bucket']}/{OVERRIDES_KEY}")
    print(f"   Total: {len(overrides)}")
    print()
    print(f"{'#':>3}  {'Tool':<10} {'Rule':<30} {'File':<25} {'Disposition':<16} {'Expires':<12} {'Status'}")
    print(f"{'─'*3}  {'─'*10} {'─'*30} {'─'*25} {'─'*16} {'─'*12} {'─'*12}")
    for i, o in enumerate(overrides, 1):
        rule = o.get("rule", "")[:29]
        file = o.get("file", "")[:24]
        status = expiration_status(o.get("expires", ""))
        print(f"{i:>3}  {o.get('tool',''):<10} {rule:<30} {file:<25} {o.get('disposition',''):<16} {o.get('expires',''):<12} {status}")


def cmd_add(args, session_data):
    # Read staged findings from stdin
    if sys.stdin.isatty():
        print("❌ Pipe findings from review-findings.py --select, e.g.:", file=sys.stderr)
        print("   python3 scripts/review-findings.py --key ... --select '1,3' | python3 scripts/manage-overrides.py add", file=sys.stderr)
        sys.exit(1)

    try:
        findings = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"❌ Invalid JSON input: {e}", file=sys.stderr)
        sys.exit(1)

    if not findings:
        print("   No findings to add.")
        return

    pipeline = session_data["pipeline_name"]
    identity = get_identity(session_data)
    today = date.today().isoformat()

    # Prompt for shared override parameters
    print(f"📋 Adding {len(findings)} finding(s) as overrides\n")
    disposition = ""
    while disposition not in ("false_positive", "accepted_risk"):
        disposition = input("Disposition (false_positive / accepted_risk): ").strip()

    justification = ""
    while not justification:
        justification = input("Justification (required): ").strip()

    expires = ""
    while True:
        expires = input("Expiration date (YYYY-MM-DD, must be future): ").strip()
        try:
            exp_date = date.fromisoformat(expires)
            if exp_date > date.today():
                break
            print("   ⚠️  Date must be in the future")
        except ValueError:
            print("   ⚠️  Invalid date format")

    # Build override entries
    s3 = boto3.Session(profile_name=session_data["profile_name"]).client("s3")
    data = download_overrides(s3, session_data["artifact_bucket"])
    existing_ids = {o["finding_id"] for o in data.get("overrides", [])}

    new_entries = []
    for f in findings:
        fid = generate_finding_id(pipeline, f["tool"], f["rule"], f["file"], f.get("line", "0"))
        if fid in existing_ids:
            print(f"   ⚠️  Duplicate: {f['tool']}/{f['rule']} in {f['file']} — already overridden, skipping")
            continue
        new_entries.append({
            "finding_id": fid,
            "tool": f["tool"],
            "rule": f["rule"],
            "file": f["file"],
            "disposition": disposition,
            "justification": justification,
            "approved_by": identity,
            "approved_date": today,
            "expires": expires,
        })

    if not new_entries:
        print("   No new overrides to add (all duplicates).")
        return

    # Confirm
    print(f"\n{'─'*60}")
    for e in new_entries:
        print(f"   {e['tool']}/{e['rule']} in {e['file']}")
    print(f"   Disposition:    {disposition}")
    print(f"   Justification:  {justification}")
    print(f"   Expires:        {expires}")
    print(f"   Approved by:    {identity}")
    print(f"{'─'*60}")

    if args.dry_run:
        print(f"\n[DRY RUN] Would add {len(new_entries)} override(s). No changes written.")
        return

    confirm = input(f"\nAdd {len(new_entries)} override(s)? (y/n): ").strip().lower()
    if confirm != "y":
        print("   Cancelled.")
        return

    # Write
    data["overrides"].extend(new_entries)
    upload_overrides(s3, session_data["artifact_bucket"], data)
    print(f"   ✅ Override file updated ({len(data['overrides'])} total entries)")

    # Suppress and log each
    for e in new_entries:
        suppress_finding(session_data, e["finding_id"], disposition, justification, expires)
        log_audit_event(session_data, {
            "event_type": "create",
            "pipeline_name": pipeline,
            "finding_id": e["finding_id"],
            "tool": e["tool"],
            "rule": e["rule"],
            "file": e["file"],
            "disposition": disposition,
            "justification": justification,
            "approved_by": identity,
            "approved_date": today,
            "expires": expires,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "iam_identity": identity,
        })


def cmd_update(args, session_data):
    s3 = boto3.Session(profile_name=session_data["profile_name"]).client("s3")
    data = download_overrides(s3, session_data["artifact_bucket"])
    overrides = data.get("overrides", [])

    if not overrides:
        print("   No overrides to update.")
        return

    idx = args.index - 1
    if idx < 0 or idx >= len(overrides):
        print(f"❌ Index {args.index} out of range (1-{len(overrides)})", file=sys.stderr)
        sys.exit(1)

    entry = overrides[idx]
    print(f"📋 Updating override #{args.index}")
    print(f"   Tool:          {entry['tool']}")
    print(f"   Rule:          {entry['rule']}")
    print(f"   File:          {entry['file']}")
    print(f"   Disposition:   {entry['disposition']}")
    print(f"   Justification: {entry['justification']}")
    print(f"   Expires:       {entry['expires']}")
    print()
    print("   Press Enter to keep current value.\n")

    new_disp = input(f"   Disposition ({entry['disposition']}): ").strip()
    if new_disp and new_disp in ("false_positive", "accepted_risk"):
        entry["disposition"] = new_disp
    elif new_disp:
        print("   ⚠️  Invalid disposition, keeping current")

    new_just = input("   Justification: ").strip()
    if new_just:
        entry["justification"] = new_just

    new_exp = input(f"   Expires ({entry['expires']}): ").strip()
    if new_exp:
        try:
            exp_date = date.fromisoformat(new_exp)
            if exp_date > date.today():
                entry["expires"] = new_exp
            else:
                print("   ⚠️  Date must be future, keeping current")
        except ValueError:
            print("   ⚠️  Invalid date, keeping current")

    if args.dry_run:
        print(f"\n[DRY RUN] Would update override #{args.index}. No changes written.")
        return

    confirm = input("\nSave changes? (y/n): ").strip().lower()
    if confirm != "y":
        print("   Cancelled.")
        return

    overrides[idx] = entry
    upload_overrides(s3, session_data["artifact_bucket"], data)
    print(f"   ✅ Override #{args.index} updated")

    identity = get_identity(session_data)
    log_audit_event(session_data, {
        "event_type": "update",
        "pipeline_name": session_data["pipeline_name"],
        "finding_id": entry["finding_id"],
        "tool": entry["tool"],
        "rule": entry["rule"],
        "file": entry["file"],
        "disposition": entry["disposition"],
        "justification": entry["justification"],
        "approved_by": identity,
        "approved_date": date.today().isoformat(),
        "expires": entry["expires"],
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "iam_identity": identity,
    })


def cmd_remove(args, session_data):
    s3 = boto3.Session(profile_name=session_data["profile_name"]).client("s3")
    data = download_overrides(s3, session_data["artifact_bucket"])
    overrides = data.get("overrides", [])

    if not overrides:
        print("   No overrides to remove.")
        return

    idx = args.index - 1
    if idx < 0 or idx >= len(overrides):
        print(f"❌ Index {args.index} out of range (1-{len(overrides)})", file=sys.stderr)
        sys.exit(1)

    entry = overrides[idx]
    print(f"🗑️  Remove override #{args.index}")
    print(f"   Tool: {entry['tool']}")
    print(f"   Rule: {entry['rule']}")
    print(f"   File: {entry['file']}")
    print(f"   Disposition: {entry['disposition']}")

    if args.dry_run:
        print(f"\n[DRY RUN] Would remove override #{args.index}. No changes written.")
        return

    confirm = input("\nRemove this override? (y/n): ").strip().lower()
    if confirm != "y":
        print("   Cancelled.")
        return

    overrides.pop(idx)
    upload_overrides(s3, session_data["artifact_bucket"], data)
    print(f"   ✅ Override removed ({len(overrides)} remaining)")

    identity = get_identity(session_data)
    log_audit_event(session_data, {
        "event_type": "delete",
        "pipeline_name": session_data["pipeline_name"],
        "finding_id": entry["finding_id"],
        "tool": entry["tool"],
        "rule": entry["rule"],
        "file": entry["file"],
        "disposition": entry["disposition"],
        "justification": entry.get("justification", ""),
        "approved_by": identity,
        "approved_date": date.today().isoformat(),
        "expires": entry.get("expires", ""),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "iam_identity": identity,
    })


def main():
    parser = argparse.ArgumentParser(description="SSDF Manager — Manage Finding Overrides")
    parser.add_argument("--profile", help="AWS profile override")
    parser.add_argument("--pipeline", help="Pipeline name (skip session file)")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without writing")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="Display current overrides")

    sub.add_parser("add", help="Add overrides from piped findings JSON")

    update_p = sub.add_parser("update", help="Update an existing override")
    update_p.add_argument("--index", type=int, required=True, help="Override index (1-based)")

    remove_p = sub.add_parser("remove", help="Remove an override")
    remove_p.add_argument("--index", type=int, required=True, help="Override index (1-based)")

    args = parser.parse_args()
    session_data = load_session(args.profile, args.pipeline)

    if args.command == "list":
        cmd_list(args, session_data)
    elif args.command == "add":
        cmd_add(args, session_data)
    elif args.command == "update":
        cmd_update(args, session_data)
    elif args.command == "remove":
        cmd_remove(args, session_data)


if __name__ == "__main__":
    main()
