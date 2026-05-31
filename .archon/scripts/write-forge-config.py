#!/usr/bin/env python3
"""
Write forge.provider to .archon/config.yaml

Reads detected provider from $ARTIFACTS_DIR/forge-provider.txt
and updates or creates .archon/config.yaml with proper YAML parsing.
"""

import os
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:
    print("ERROR: PyYAML not installed", file=sys.stderr)
    print("Install with: pip install pyyaml", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    print("=== Writing Forge Configuration ===")
    print()

    # Read detected provider from artifacts
    artifacts_dir = os.environ.get("ARTIFACTS_DIR")
    if not artifacts_dir:
        print("ERROR: ARTIFACTS_DIR environment variable not set", file=sys.stderr)
        return 1

    provider_file = Path(artifacts_dir) / "forge-provider.txt"
    if not provider_file.exists():
        print(f"ERROR: Provider file not found: {provider_file}", file=sys.stderr)
        print("Forge detection step may have failed.", file=sys.stderr)
        return 1

    provider = provider_file.read_text().strip()
    if not provider:
        print("ERROR: Provider file is empty", file=sys.stderr)
        return 1

    if provider not in ("github", "gitlab"):
        print(f"ERROR: Invalid provider: {provider}", file=sys.stderr)
        print("Expected 'github' or 'gitlab'", file=sys.stderr)
        return 1

    print(f"Provider to write: {provider}")

    # Create .archon directory if needed
    archon_dir = Path(".archon")
    archon_dir.mkdir(parents=True, exist_ok=True)

    if not archon_dir.is_dir():
        print(f"ERROR: Failed to create directory: {archon_dir}", file=sys.stderr)
        return 1

    config_path = archon_dir / "config.yaml"

    # Load existing config or create new structure
    config: dict[str, Any]
    if config_path.exists():
        print(f"Reading existing config: {config_path}")
        try:
            with config_path.open("r") as f:
                loaded = yaml.safe_load(f)
                config = loaded if isinstance(loaded, dict) else {}
        except yaml.YAMLError as e:
            print(f"ERROR: Failed to parse existing config: {e}", file=sys.stderr)
            return 1
    else:
        print(f"Creating new config: {config_path}")
        config = {
            "worktree": {"baseBranch": "dev"},
            "docs": {"path": "docs/"},
        }

    # Update forge.provider
    if "forge" not in config:
        config["forge"] = {}

    config["forge"]["provider"] = provider

    # Write config back
    try:
        with config_path.open("w") as f:
            yaml.safe_dump(
                config,
                f,
                default_flow_style=False,
                sort_keys=False,
                allow_unicode=True,
            )
        print(f"✓ Wrote forge.provider={provider} to {config_path}")
    except Exception as e:
        print(f"ERROR: Failed to write config: {e}", file=sys.stderr)
        return 1

    print()
    print("Configuration updated successfully.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
