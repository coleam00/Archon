#!/usr/bin/env python3
"""Generate SSDF pipeline variant definition from a pipeline profile YAML."""
import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


def _parse_stages(content: str) -> list[dict]:
    """Extract pipeline stages with nist_mapping, name, purpose, tools."""
    stages = []
    current: dict = {}
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("- name:"):
            if current:
                stages.append(current)
            current = {"name": stripped.split(":", 1)[1].strip().strip('"'), "practices": [], "tools": [], "purpose": ""}
        elif stripped.startswith("purpose:") and current:
            current["purpose"] = stripped.split(":", 1)[1].strip().strip('"')
        elif stripped.startswith("nist_mapping:") and current:
            practices = re.findall(r'"([A-Z]{2}\.\d+\.\d+)"', stripped)
            current["practices"] = practices
        elif stripped.startswith("tools:") and current:
            tools = re.findall(r'"([^"]+)"', stripped)
            current["tools"] = tools
    if current:
        stages.append(current)
    return stages


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate pipeline variant from profile")
    parser.add_argument("--profile", required=True, help="Path to pipeline profile YAML")
    parser.add_argument("--variant-id", required=True, help="Variant ID (e.g., codepipeline-serverless-v1)")
    parser.add_argument("--output-dir", default=str(Path.home() / ".kiro" / "config" / "ssdf-pipeline-variants"),
                        help="Output directory")
    args = parser.parse_args()

    profile_path = Path(args.profile)
    if not profile_path.exists():
        print(f"Error: Profile not found: {profile_path}", file=sys.stderr)
        return 1

    content = profile_path.read_text()
    stages = _parse_stages(content)

    # Build practice → evidence mapping (first stage wins)
    seen: dict[str, dict] = {}
    for stage in stages:
        for pid in stage["practices"]:
            if pid not in seen:
                tools_str = ", ".join(stage["tools"]) if stage["tools"] else "pipeline-logic"
                seen[pid] = {
                    "practice_id": pid,
                    "evidence": f"{stage['purpose'] or stage['name']} ({tools_str})",
                    "stage": stage["name"],
                }

    # Parse variant ID components
    parts = args.variant_id.rsplit("-", 1)
    version = parts[1] if len(parts) > 1 and parts[1].startswith("v") else "v1"
    prefix = parts[0] if len(parts) > 1 and parts[1].startswith("v") else args.variant_id
    platform_type = prefix.split("-", 1)
    platform = platform_type[0] if len(platform_type) > 1 else prefix
    ptype = platform_type[1] if len(platform_type) > 1 else "generic"

    variant = {
        "variant_id": args.variant_id,
        "platform": platform,
        "type": ptype,
        "version": version,
        "description": "",
        "source_profile": profile_path.name,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "inheritable_practices": sorted(seen.values(), key=lambda x: x["practice_id"]),
    }

    # Extract description from profile
    for line in content.splitlines():
        if line.strip().startswith("description:"):
            variant["description"] = line.split(":", 1)[1].strip().strip('"')
            break

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"{args.variant_id}.json"
    out_file.write_text(json.dumps(variant, indent=2) + "\n")
    print(f"Generated: {out_file}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
