#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""AWS Profile Selection and Pipeline Discovery for SSDF Manager."""

import argparse
import json
import os
import re
import sys
from configparser import ConfigParser
from datetime import datetime
from pathlib import Path

import boto3

SESSION_FILE = Path(__file__).resolve().parent.parent / ".session.json"


def get_available_profiles():
    """List AWS CLI profiles from config and credentials files."""
    profiles = []
    config_file = Path.home() / ".aws" / "config"
    if config_file.exists():
        config = ConfigParser()
        config.read(config_file)
        for section in config.sections():
            if section.startswith("profile "):
                profiles.append(section.replace("profile ", ""))
    creds_file = Path.home() / ".aws" / "credentials"
    if creds_file.exists():
        config = ConfigParser()
        config.read(creds_file)
        for section in config.sections():
            if section not in profiles:
                profiles.append(section)
    return sorted(profiles)


def validate_profile(profile_name):
    """Validate profile via sts:GetCallerIdentity."""
    try:
        session = boto3.Session(profile_name=profile_name)
        sts = session.client("sts")
        identity = sts.get_caller_identity()
        return {
            "valid": True,
            "profile_name": profile_name,
            "account_id": identity["Account"],
            "region": session.region_name or "us-east-1",
            "arn": identity["Arn"],
        }
    except Exception as e:
        return {"valid": False, "profile_name": profile_name, "error": str(e)}


def discover_pipelines(session, account_id, region):
    """Find pipeline artifact buckets in the account."""
    s3 = session.client("s3")
    pattern = re.compile(rf"^(.+)-artifacts-{account_id}-{region}$")
    pipelines = []
    try:
        buckets = s3.list_buckets().get("Buckets", [])
        for bucket in buckets:
            match = pattern.match(bucket["Name"])
            if match:
                pipelines.append(
                    {"pipeline_name": match.group(1), "bucket": bucket["Name"]}
                )
    except Exception as e:
        print(f"⚠️  Could not list buckets: {e}")
    return pipelines


def save_session(profile_info, pipeline_name, artifact_bucket):
    """Save session with pipeline context."""
    session_data = {
        "profile_name": profile_info["profile_name"],
        "account_id": profile_info["account_id"],
        "region": profile_info["region"],
        "arn": profile_info["arn"],
        "validated_at": datetime.now().isoformat(),
        "pipeline_name": pipeline_name,
        "artifact_bucket": artifact_bucket,
    }
    with open(SESSION_FILE, "w") as f:
        json.dump(session_data, f, indent=2)
    # Restrict file permissions: 0600 on Unix, ACL owner-only on Windows
    if sys.platform != "win32":
        os.chmod(SESSION_FILE, 0o600)
    return session_data


def load_session():
    """Load current session if exists."""
    if SESSION_FILE.exists():
        with open(SESSION_FILE) as f:
            return json.load(f)
    return None


def main():
    parser = argparse.ArgumentParser(description="SSDF Manager — Profile & Pipeline Selection")
    parser.add_argument("--profile", help="AWS profile name (skip interactive selection)")
    parser.add_argument("--pipeline", help="Pipeline name (skip discovery)")
    args = parser.parse_args()

    print("⚙️  SSDF Manager — Profile & Pipeline Selection")
    print()

    current = load_session()
    if current:
        print(f"📍 Current session: {current.get('profile_name')} / {current.get('pipeline_name', 'none')}")
        print(f"   Account: {current.get('account_id')}  Region: {current.get('region')}")
        print()

    # Profile selection
    if args.profile:
        selected_profile = args.profile
    else:
        profiles = get_available_profiles()
        if not profiles:
            print("❌ No AWS profiles found in ~/.aws/config or ~/.aws/credentials")
            sys.exit(1)
        print("📋 Available AWS Profiles:")
        for i, p in enumerate(profiles, 1):
            marker = "✓" if current and current.get("profile_name") == p else " "
            print(f"   {i}. [{marker}] {p}")
        print()
        try:
            choice = input("Select profile number (or 'q' to quit): ").strip()
            if choice.lower() == "q":
                return
            idx = int(choice) - 1
            if idx < 0 or idx >= len(profiles):
                print("❌ Invalid selection")
                sys.exit(1)
            selected_profile = profiles[idx]
        except (ValueError, KeyboardInterrupt):
            print("\n❌ Cancelled")
            sys.exit(1)

    # Validate
    print(f"\n🔍 Validating profile: {selected_profile}...")
    validation = validate_profile(selected_profile)
    if not validation["valid"]:
        print(f"❌ Validation failed: {validation['error']}")
        sys.exit(1)
    print(f"✅ Account: {validation['account_id']}  Region: {validation['region']}")

    # Pipeline discovery
    session = boto3.Session(profile_name=selected_profile)
    if args.pipeline:
        pipeline_name = args.pipeline
        artifact_bucket = f"{pipeline_name}-artifacts-{validation['account_id']}-{validation['region']}"
        print(f"\n📦 Pipeline: {pipeline_name}")
        print(f"   Bucket: {artifact_bucket}")
    else:
        print("\n🔍 Discovering pipeline instances...")
        pipelines = discover_pipelines(session, validation["account_id"], validation["region"])
        if not pipelines:
            print("❌ No pipeline artifact buckets found matching *-artifacts-{account}-{region}")
            print("   Use --pipeline to specify manually")
            sys.exit(1)
        if len(pipelines) == 1:
            pipeline_name = pipelines[0]["pipeline_name"]
            artifact_bucket = pipelines[0]["bucket"]
            print(f"   Found: {pipeline_name}")
        else:
            print("📋 Available Pipelines:")
            for i, p in enumerate(pipelines, 1):
                print(f"   {i}. {p['pipeline_name']}")
            try:
                choice = input("\nSelect pipeline number: ").strip()
                idx = int(choice) - 1
                if idx < 0 or idx >= len(pipelines):
                    print("❌ Invalid selection")
                    sys.exit(1)
                pipeline_name = pipelines[idx]["pipeline_name"]
                artifact_bucket = pipelines[idx]["bucket"]
            except (ValueError, KeyboardInterrupt):
                print("\n❌ Cancelled")
                sys.exit(1)

    # Save session
    session_data = save_session(validation, pipeline_name, artifact_bucket)
    print("\n✅ Session configured:")
    print(f"   Profile:  {session_data['profile_name']}")
    print(f"   Pipeline: {session_data['pipeline_name']}")
    print(f"   Bucket:   {session_data['artifact_bucket']}")
    print(f"   Saved to: {SESSION_FILE}")


if __name__ == "__main__":
    main()
