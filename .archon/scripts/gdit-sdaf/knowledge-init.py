#!/usr/bin/env python3
"""Knowledge base initialization and freshness management for GDIT-SDAF.

Auto-discovers indexable directories from project structure based on
project-organization.md conventions. Skips re-indexing when content
hasn't changed (git-based freshness check).

Usage:
    python3 ~/.kiro/scripts/knowledge-init.py --project-dir /path/to/project [--force] [--dry-run]
    python3 ~/.kiro/scripts/knowledge-init.py --configure-only
"""

import json
import subprocess
import sys
from pathlib import Path

# --- Configuration ---

KIRO_SETTINGS = {
    "chat.enableKnowledge": "true",
    "knowledge.indexType": "Best",
    "knowledge.chunkSize": "1024",
    "knowledge.chunkOverlap": "256",
    "knowledge.maxFiles": "10000",
    "knowledge.defaultExcludePatterns": json.dumps([
        "node_modules/**", ".venv/**", "build/**", "dist/**",
        "archive/**", "__pycache__/**", ".git/**", "*.bak",
        "*.zip", "temp-*",
    ]),
}

# Auto-discovery candidates ordered by priority (from project-organization.md).
# Each entry: subdir to check, index_type, include patterns, optional exclude patterns.
_KB_CANDIDATES = [
    {
        "subdir": ".kiro/specs",
        "index_type": "Best",
        "include": ["**/*.md"],
        "exclude": ["archive/**", "backup/**"],
        "description": "Feature specifications (requirements, design, tasks)",
    },
    {
        "subdir": "src/layers",
        "index_type": "Best",
        "include": ["**/*.py", "**/*.ts", "**/*.js"],
        "description": "Shared library/layer code",
    },
    {
        "subdir": "src/handlers",
        "index_type": "Fast",
        "include": ["**/*.py", "**/*.ts", "**/*.js", "**/*.java", "**/*.cs"],
        "description": "Lambda/handler source code",
    },
    {
        "subdir": "src",
        "index_type": "Best",
        "include": ["**/*.py", "**/*.ts", "**/*.js", "**/*.java", "**/*.cs", "**/*.go"],
        "exclude": ["**/__pycache__/**", "**/node_modules/**"],
        "description": "Application source code",
    },
    {
        "subdir": "infrastructure/cloudformation",
        "index_type": "Fast",
        "include": ["**/*.yml", "**/*.yaml"],
        "exclude": ["archive/**"],
        "description": "CloudFormation templates",
    },
    {
        "subdir": "infrastructure/sam",
        "index_type": "Fast",
        "include": ["**/*.yml", "**/*.yaml"],
        "description": "SAM templates",
    },
    {
        "subdir": "infrastructure/terraform",
        "index_type": "Fast",
        "include": ["**/*.tf"],
        "description": "Terraform modules",
    },
    {
        "subdir": "infrastructure/cdk",
        "index_type": "Fast",
        "include": ["**/*.ts", "**/*.py", "**/*.java", "**/*.cs"],
        "description": "CDK stacks",
    },
    {
        "subdir": "infrastructure",
        "index_type": "Fast",
        "include": ["**/*.yml", "**/*.yaml", "**/*.tf", "**/*.json"],
        "exclude": ["archive/**"],
        "description": "Infrastructure as Code",
    },
    {
        "subdir": "frontend/src/services",
        "index_type": "Best",
        "include": ["**/*.js", "**/*.ts"],
        "exclude": ["**/__tests__/**", "**/*.test.*", "**/*.disabled"],
        "description": "Frontend service layer",
    },
    {
        "subdir": "frontend/src/schemas",
        "index_type": "Best",
        "include": ["**/*.ts", "**/*.js"],
        "exclude": ["**/__tests__/**", "**/*.test.*"],
        "description": "Frontend validation schemas",
    },
    {
        "subdir": "frontend/src",
        "index_type": "Best",
        "include": ["**/*.js", "**/*.ts", "**/*.jsx", "**/*.tsx"],
        "exclude": ["**/__tests__/**", "**/*.test.*", "**/node_modules/**"],
        "description": "Frontend source code",
    },
    {
        "subdir": "docs",
        "index_type": "Best",
        "include": ["**/*.md"],
        "description": "Project documentation",
    },
    {
        "subdir": ".kiro/registry",
        "index_type": "Fast",
        "include": ["**/*.yaml", "**/*.yml"],
        "description": "Shared component registry",
    },
    {
        "subdir": ".kiro/config",
        "index_type": "Fast",
        "include": ["**/*.yaml", "**/*.yml", "**/*.md"],
        "description": "Project configuration and design system",
    },
]

FRESHNESS_FILE = Path.home() / ".kiro" / ".knowledge-freshness.json"


def run(cmd: list[str], cwd: str | None = None) -> subprocess.CompletedProcess:
    """Run a command and return result."""
    return subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)


def get_project_root() -> Path | None:
    """Find the project root via --project-dir or cwd."""
    for i, arg in enumerate(sys.argv):
        if arg == "--project-dir" and i + 1 < len(sys.argv):
            candidate = Path(sys.argv[i + 1])
            if (candidate / ".kiro" / "config" / "project.yaml").exists():
                return candidate

    cwd = Path.cwd()
    if (cwd / ".kiro" / "config" / "project.yaml").exists():
        return cwd
    return None


def discover_knowledge_bases(project_root: Path) -> list[dict]:
    """Auto-discover knowledge bases from project structure.

    Uses project-organization.md conventions to find indexable directories.
    Avoids parent/child overlap (e.g., won't add both src/ and src/layers/).
    """
    project_name = project_root.name
    discovered = []
    seen_subdirs: set[str] = set()

    for candidate in _KB_CANDIDATES:
        path = project_root / candidate["subdir"]
        if not path.is_dir():
            continue

        # Skip if a more specific child already claimed (src/layers before src/)
        is_parent_of_existing = any(
            s.startswith(candidate["subdir"] + "/") for s in seen_subdirs
        )
        is_child_of_existing = any(
            candidate["subdir"].startswith(s + "/") for s in seen_subdirs
        )
        if is_parent_of_existing or is_child_of_existing:
            continue

        seen_subdirs.add(candidate["subdir"])
        kb_name = f"{project_name}-{candidate['subdir'].replace('/', '-').replace('.', '').strip('-')}"
        discovered.append({
            "name": kb_name,
            "path": candidate["subdir"],
            "index_type": candidate["index_type"],
            "include": candidate.get("include", []),
            "exclude": candidate.get("exclude", []),
            "description": candidate["description"],
        })

    return discovered


def configure_settings(dry_run: bool = False) -> None:
    """Apply kiro-cli knowledge settings."""
    print("Configuring kiro-cli knowledge settings...")
    for key, value in KIRO_SETTINGS.items():
        if dry_run:
            print(f"  [dry-run] kiro-cli settings {key} {value}")
        else:
            result = run(["kiro-cli", "settings", key, value])
            status = "✓" if result.returncode == 0 else f"✗ ({result.stderr.strip()})"
            print(f"  {status} {key}")


def load_freshness() -> dict:
    """Load freshness timestamps."""
    if FRESHNESS_FILE.exists():
        return json.loads(FRESHNESS_FILE.read_text())
    return {}


def save_freshness(data: dict) -> None:
    """Save freshness timestamps."""
    FRESHNESS_FILE.write_text(json.dumps(data, indent=2))


def get_content_hash(project_root: Path, kb: dict) -> str:
    """Get a hash of the content for a knowledge base path.

    Uses git commit hash when available; falls back to directory mtime
    for non-git projects or uncommitted-only content.
    """
    target = project_root / kb["path"]
    if not target.exists():
        return ""
    # Try git first
    result = run(
        ["git", "log", "-1", "--format=%H", "--", kb["path"]],
        cwd=str(project_root),
    )
    git_hash = result.stdout.strip() if result.returncode == 0 else ""
    if git_hash:
        return git_hash
    # Fallback: use max mtime of files in directory
    try:
        max_mtime = max(
            (f.stat().st_mtime for f in target.rglob("*") if f.is_file()),
            default=0.0,
        )
        return f"mtime:{int(max_mtime)}" if max_mtime else ""
    except OSError:
        return ""


def needs_update(kb_name: str, content_hash: str, freshness: dict) -> bool:
    """Check if a knowledge base needs re-indexing."""
    if not content_hash:
        return True
    stored = freshness.get(kb_name, {}).get("hash", "")
    return stored != content_hash


def build_add_command(kb: dict, project_root: Path) -> list[str]:
    """Build the /knowledge add command arguments for a knowledge base."""
    target_path = str(project_root / kb["path"])
    cmd = ["--name", kb["name"], "--path", target_path, "--index-type", kb["index_type"]]

    for pattern in kb.get("include", []):
        cmd.extend(["--include", pattern])
    for pattern in kb.get("exclude", []):
        cmd.extend(["--exclude", pattern])

    return cmd


def index_knowledge_bases(project_root: Path, force: bool = False, dry_run: bool = False) -> None:
    """Index all discovered knowledge bases, skipping fresh ones."""
    knowledge_bases = discover_knowledge_bases(project_root)

    if not knowledge_bases:
        print("  No indexable directories found in project.")
        return

    freshness = load_freshness()
    stale = 0
    fresh = 0

    for kb in knowledge_bases:
        target = project_root / kb["path"]
        if not target.exists():
            continue

        content_hash = get_content_hash(project_root, kb)

        if not force and not needs_update(kb["name"], content_hash, freshness):
            fresh += 1
            if dry_run:
                print(f"  [fresh] {kb['name']} (unchanged since last index)")
            continue

        cmd_args = build_add_command(kb, project_root)

        if dry_run:
            print(f"  [stale] {kb['name']} — needs re-index")
            print(f"          /knowledge add {' '.join(cmd_args)}")
            print(f"          → {kb['description']}")
        else:
            freshness[kb["name"]] = {"hash": content_hash, "index_type": kb["index_type"]}
            print(f"  ↻ {kb['name']} marked for re-index ({kb['description']})")
            stale += 1

    if not dry_run:
        save_freshness(freshness)

    print(f"\nKnowledge bases: {stale} marked stale, {fresh} fresh, {len(knowledge_bases)} discovered")


def main() -> None:
    args = sys.argv[1:]
    force = "--force" in args
    dry_run = "--dry-run" in args
    configure_only = "--configure-only" in args

    configure_settings(dry_run=dry_run)

    if configure_only:
        print("\nSettings configured. Use --force to re-index all knowledge bases.")
        return

    project_root = get_project_root()
    if not project_root:
        print("\n⚠ Project root not found. Skipping knowledge indexing.")
        print("  Expected: .kiro/config/project.yaml in --project-dir or cwd")
        return

    print(f"\nDiscovering knowledge bases from: {project_root}")
    index_knowledge_bases(project_root, force=force, dry_run=dry_run)


if __name__ == "__main__":
    main()
