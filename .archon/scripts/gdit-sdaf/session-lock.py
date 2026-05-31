#!/usr/bin/env python3
"""Session coordination for parallel kiro-cli sessions.

Manages file-level locks so two sessions working on different features
in the same branch don't modify the same file simultaneously.

State file: .kiro/active-work.json (project-local, created on first use)
"""
import argparse
import json
import re
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path

HIGH_RISK_PATTERNS = [
    "schema.graphql", "infrastructure/cloudformation/", "layers/shared/python/",
    "package.json", "package-lock.json", "requirements.txt",
]


def find_state_file():
    return Path.cwd() / ".kiro" / "active-work.json"


def load_state(state_file):
    if not state_file.exists():
        return {"sessions": {}}
    data = json.loads(state_file.read_text())
    return data if data and "sessions" in data else {"sessions": {}}


def save_state(state_file, data):
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(json.dumps(data, indent=2) + "\n")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def find_lock_holder(data, filepath):
    for name, info in data.get("sessions", {}).items():
        if filepath in info.get("locked_files", []):
            return name
    return None


def cmd_register(args, state_file):
    data = load_state(state_file)
    if args.session in data["sessions"]:
        print(f"Error: session '{args.session}' already registered", file=sys.stderr)
        return 1
    data["sessions"][args.session] = {
        "spec": args.spec, "locked_files": [],
        "registered": now_iso(), "last_updated": now_iso(),
    }
    save_state(state_file, data)
    print(f"Registered session '{args.session}'")
    return 0


def cmd_auto_register(args, state_file):
    data = load_state(state_file)
    spec_path = args.spec
    base = Path(spec_path).name.strip("/") or "session"
    for _ in range(10):
        name = f"{base}-{secrets.token_hex(2)}"
        if name not in data["sessions"]:
            data["sessions"][name] = {
                "spec": spec_path, "locked_files": [],
                "registered": now_iso(), "last_updated": now_iso(),
            }
            save_state(state_file, data)
            print(name)
            return 0
    print("Error: failed to generate unique session name after 10 attempts", file=sys.stderr)
    return 1


def cmd_lock(args, state_file):
    data = load_state(state_file)
    session = data["sessions"].get(args.session)
    if not session:
        print(f"Error: session '{args.session}' not registered", file=sys.stderr)
        return 1
    holder = find_lock_holder(data, args.file)
    if holder and holder != args.session:
        deferred = session.setdefault("deferred_files", [])
        entry = {"file": args.file, "held_by": holder, "timestamp": now_iso()}
        # Replace existing entry for same file or append
        deferred[:] = [d for d in deferred if d["file"] != args.file]
        deferred.append(entry)
        session["last_updated"] = now_iso()
        save_state(state_file, data)
        print(f"CONFLICT: '{args.file}' is locked by session '{holder}'", file=sys.stderr)
        return 1
    if args.file not in session.get("locked_files", []):
        session.setdefault("locked_files", []).append(args.file)
    # Clear from deferred if previously blocked
    if "deferred_files" in session:
        session["deferred_files"] = [d for d in session["deferred_files"] if d["file"] != args.file]
    session["last_updated"] = now_iso()
    save_state(state_file, data)
    return 0


def cmd_release(args, state_file):
    data = load_state(state_file)
    session = data["sessions"].get(args.session)
    if not session:
        return 0
    files = session.get("locked_files", [])
    if args.file in files:
        files.remove(args.file)
    session["last_updated"] = now_iso()
    save_state(state_file, data)
    return 0


def cmd_release_all(args, state_file):
    data = load_state(state_file)
    if args.session in data["sessions"]:
        del data["sessions"][args.session]
    save_state(state_file, data)
    print(f"Released all locks and deregistered '{args.session}'")
    return 0


def cmd_cleanup(args, state_file):
    """Remove stale sessions that haven't been updated within the timeout."""
    data = load_state(state_file)
    if not data["sessions"]:
        print("No sessions to clean up")
        return 0
    now = datetime.now(timezone.utc)
    timeout = args.stale_timeout
    stale = []
    for name, info in data["sessions"].items():
        try:
            ts = info.get("last_updated", info.get("registered", ""))
            if ts:
                last = datetime.fromisoformat(str(ts))
                if last.tzinfo is None:
                    last = last.replace(tzinfo=timezone.utc)
                if (now - last).total_seconds() > timeout:
                    stale.append(name)
        except (ValueError, TypeError):
            stale.append(name)  # unparseable timestamp = stale
    if not stale:
        print("No stale sessions found")
        return 0
    for name in stale:
        locked = data["sessions"][name].get("locked_files", [])
        if args.dry_run:
            print(f"  [dry-run] would remove: {name} (locked: {', '.join(locked) or 'none'})")
        else:
            del data["sessions"][name]
            print(f"  removed: {name} (released {len(locked)} lock(s))")
    if not args.dry_run:
        save_state(state_file, data)
        print(f"Cleaned up {len(stale)} stale session(s)")
    return 0


def cmd_my_files(args, state_file):
    data = load_state(state_file)
    session = data["sessions"].get(args.session)
    if not session:
        return 0
    for f in session.get("locked_files", []):
        print(f)
    return 0


def cmd_status(args, state_file):
    data = load_state(state_file)
    if not data["sessions"]:
        print("No active sessions")
        return 0
    timeout = getattr(args, "stale_timeout", 7200)
    now = datetime.now(timezone.utc)
    for name, info in data["sessions"].items():
        stale = ""
        try:
            ts = info.get("last_updated", "")
            if ts:
                last = datetime.fromisoformat(str(ts))
                if last.tzinfo is None:
                    last = last.replace(tzinfo=timezone.utc)
                if (now - last).total_seconds() > timeout:
                    stale = " [STALE]"
        except (ValueError, TypeError):
            pass
        files = info.get("locked_files", [])
        print(f"  {name}{stale}")
        print(f"    spec: {info.get('spec', '?')}")
        print(f"    locked: {', '.join(files) if files else '(none)'}")
        deferred = info.get("deferred_files", [])
        if deferred:
            print(f"    deferred: {', '.join(d['file'] + ' (held by ' + d['held_by'] + ')' for d in deferred)}")
    return 0


def extract_paths(text):
    return set(re.findall(r"`([^`]+\.[a-zA-Z]{1,10})`", text))


def cmd_analyze(args, state_file):
    root = Path.cwd()
    paths1, paths2 = set(), set()
    for fname in ["tasks.md", "design.md"]:
        for spec, paths in [(args.spec1, paths1), (args.spec2, paths2)]:
            f = root / spec / fname
            if f.exists():
                paths.update(extract_paths(f.read_text()))
    shared = paths1 & paths2
    if not shared:
        print("No crossover files detected between the two specs.")
        return 0
    high = [f for f in shared if any(p in f for p in HIGH_RISK_PATTERNS)]
    low = [f for f in shared if f not in high]
    if high:
        print("HIGH-RISK crossover (serialize these):")
        for f in sorted(high):
            print(f"  - {f}")
    if low:
        print("Low-risk crossover:")
        for f in sorted(low):
            print(f"  - {f}")
    if high:
        print("\nRecommendation: Complete one feature's changes to high-risk files before the other starts.")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Session coordination for parallel kiro-cli work")
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("register")
    p.add_argument("--session", required=True)
    p.add_argument("--spec", required=True)

    p = sub.add_parser("auto-register")
    p.add_argument("--spec", required=True)

    p = sub.add_parser("lock")
    p.add_argument("--session", required=True)
    p.add_argument("--file", required=True)

    p = sub.add_parser("release")
    p.add_argument("--session", required=True)
    p.add_argument("--file", required=True)

    p = sub.add_parser("release-all")
    p.add_argument("--session", required=True)
    p.add_argument("--force", action="store_true")

    p = sub.add_parser("my-files")
    p.add_argument("--session", required=True)

    p = sub.add_parser("status")
    p.add_argument("--stale-timeout", type=int, default=7200)

    p = sub.add_parser("cleanup")
    p.add_argument("--stale-timeout", type=int, default=7200, help="Seconds since last update to consider stale (default: 7200 = 2h)")
    p.add_argument("--dry-run", action="store_true", help="Preview what would be removed without deleting")

    p = sub.add_parser("analyze")
    p.add_argument("--spec1", required=True)
    p.add_argument("--spec2", required=True)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return 1

    state_file = find_state_file()
    commands = {
        "register": cmd_register, "auto-register": cmd_auto_register,
        "lock": cmd_lock, "release": cmd_release,
        "release-all": cmd_release_all, "cleanup": cmd_cleanup,
        "my-files": cmd_my_files,
        "status": cmd_status, "analyze": cmd_analyze,
    }
    return commands[args.command](args, state_file)


if __name__ == "__main__":
    sys.exit(main())
