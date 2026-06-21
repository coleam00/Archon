#!/usr/bin/env bash
set -Eeuo pipefail

# Add or remove Spec Kit consumer repositories here.
REPOS=(
  "/Users/dale/Desktop/workspace/OceanLabs/x10.oh.cowork"
  "/Users/dale/Desktop/workspace/OceanLabs/workflow-engine/no-mistakes"
  "/Users/dale/Desktop/workspace/OceanLabs/workflow-engine/Archon"
)

EXTENSION_ID="red-team"
PRIORITY="${PRIORITY:-10}"
DRY_RUN=0
INSTALL_SOURCE=""
STAGED_SOURCE_DIR=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
EXTENSION_SOURCE="$SCRIPT_DIR"

usage() {
  cat <<EOF
Usage:
  ./install-extension.sh [options] [repo ...]

Installs this Spec Kit extension into each repo in REPOS.
If the extension is already installed, it is removed and reinstalled from the
local source path while preserving project lens/config files.

Options:
  --repo PATH       Install/update one repo. Can be passed multiple times.
  --source PATH     Extension source directory. Default: this script's directory.
  --priority N      Specify extension priority. Default: ${PRIORITY}
  --dry-run         Print actions without changing files.
  -h, --help        Show this help.

Default repos are listed at the top of this script.
EOF
}

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

run_in_repo() {
  local repo="$1"
  shift

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '+ cd %q &&' "$repo"
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi

  (cd "$repo" && "$@")
}

copy_file() {
  local source="$1"
  local destination="$2"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '+ cp %q %q\n' "$source" "$destination"
    return 0
  fi

  cp "$source" "$destination"
}

make_dir() {
  local directory="$1"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '+ mkdir -p %q\n' "$directory"
    return 0
  fi

  mkdir -p "$directory"
}

stage_extension_source() {
  local source="$1"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    INSTALL_SOURCE="${TMPDIR:-/tmp}/speckit-$EXTENSION_ID-source.DRYRUN/source"
    printf '+ rsync -a --exclude %q %q/ %q/\n' '.*/' "$source" "$INSTALL_SOURCE"
    return 0
  fi

  command -v rsync >/dev/null 2>&1 || die "rsync is required to stage extension source"

  STAGED_SOURCE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/speckit-$EXTENSION_ID-source.XXXXXX")"
  INSTALL_SOURCE="$STAGED_SOURCE_DIR/source"
  mkdir -p "$INSTALL_SOURCE"
  rsync -a --exclude='.*/' "$source"/ "$INSTALL_SOURCE"/
}

cleanup_staged_source() {
  if [[ "$DRY_RUN" -ne 1 && -n "$STAGED_SOURCE_DIR" ]]; then
    rm -rf "$STAGED_SOURCE_DIR"
  fi
}

extension_is_installed() {
  local repo="$1"
  local registry="$repo/.specify/extensions/.registry"

  if command -v python3 >/dev/null 2>&1 && [[ -f "$registry" ]]; then
    python3 - "$registry" "$EXTENSION_ID" <<'PY'
import json
import sys

registry_path, extension_id = sys.argv[1], sys.argv[2]
try:
    with open(registry_path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
except Exception:
    sys.exit(1)

sys.exit(0 if extension_id in data.get("extensions", {}) else 1)
PY
    return
  fi

  [[ -f "$repo/.specify/extensions/$EXTENSION_ID/extension.yml" ]]
}

backup_project_config() {
  local extension_dir="$1"
  local backup_dir="$2"

  [[ -d "$extension_dir" ]] || return 0

  make_dir "$backup_dir"

  local file
  for file in \
    "$extension_dir/red-team-lenses.yml" \
    "$extension_dir/red-team-lenses.local.yml" \
    "$extension_dir"/*-config.yml \
    "$extension_dir"/*-config.local.yml
  do
    [[ -f "$file" ]] || continue
    copy_file "$file" "$backup_dir/$(basename "$file")"
  done
}

restore_project_config() {
  local backup_dir="$1"
  local extension_dir="$2"

  [[ -d "$backup_dir" ]] || return 0

  make_dir "$extension_dir"

  local file
  for file in "$backup_dir"/*; do
    [[ -f "$file" ]] || continue
    copy_file "$file" "$extension_dir/$(basename "$file")"
  done
}

backup_registry_state() {
  local repo="$1"
  local backup_dir="$2"
  local registry="$repo/.specify/extensions/.registry"

  [[ -f "$registry" ]] || return 0
  make_dir "$backup_dir"
  copy_file "$registry" "$backup_dir/registry.before.json"
}

merge_registry_state() {
  local repo="$1"
  local backup_dir="$2"
  local registry="$repo/.specify/extensions/.registry"
  local previous_registry="$backup_dir/registry.before.json"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '+ merge extension registry %q into %q\n' "$previous_registry" "$registry"
    return 0
  fi

  [[ -f "$previous_registry" && -f "$registry" ]] || return 0

  command -v jq >/dev/null 2>&1 || die "jq is required to preserve $registry"

  local merged_registry
  merged_registry="$(mktemp "$registry.XXXXXX")"

  if ! jq -s '
    .[0] as $old |
    .[1] as $new |
    ($old + $new)
    | .schema_version = ($new.schema_version // $old.schema_version // "1.0")
    | .extensions = (($old.extensions // {}) + ($new.extensions // {}))
  ' "$previous_registry" "$registry" > "$merged_registry"; then
    rm -f "$merged_registry"
    return 1
  fi

  mv "$merged_registry" "$registry"
}

restore_registry_state() {
  local repo="$1"
  local backup_dir="$2"
  local registry="$repo/.specify/extensions/.registry"
  local previous_registry="$backup_dir/registry.before.json"

  [[ -f "$previous_registry" ]] || return 0
  copy_file "$previous_registry" "$registry"
}

ensure_lens_catalog() {
  local repo="$1"
  local extension_dir="$repo/.specify/extensions/$EXTENSION_ID"
  local lens_catalog="$extension_dir/red-team-lenses.yml"
  local template="$EXTENSION_SOURCE/config-template.yml"

  if [[ -f "$lens_catalog" ]]; then
    return 0
  fi

  if [[ ! -f "$template" ]]; then
    log "WARN: missing $template; cannot scaffold red-team-lenses.yml"
    return 0
  fi

  log "Scaffolding .specify/extensions/$EXTENSION_ID/red-team-lenses.yml"
  copy_file "$template" "$lens_catalog"
}

install_or_update_repo() {
  local repo="$1"
  local extension_dir="$repo/.specify/extensions/$EXTENSION_ID"
  local backup_dir
  local status=0

  if [[ ! -d "$repo" ]]; then
    log "SKIP: $repo does not exist"
    return 1
  fi

  if [[ ! -d "$repo/.specify" ]]; then
    log "SKIP: $repo is not a Spec Kit project (.specify missing)"
    return 1
  fi

  log ""
  log "==> $repo"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    backup_dir="${TMPDIR:-/tmp}/speckit-$EXTENSION_ID-backup.DRYRUN"
  else
    backup_dir="$(mktemp -d "${TMPDIR:-/tmp}/speckit-$EXTENSION_ID.XXXXXX")" || return 1
  fi

  backup_registry_state "$repo" "$backup_dir" || status=1

  if extension_is_installed "$repo"; then
    log "Updating $EXTENSION_ID"
    backup_project_config "$extension_dir" "$backup_dir" || status=1
    if [[ "$status" -eq 0 ]]; then
      run_in_repo "$repo" specify extension remove "$EXTENSION_ID" --keep-config --force || status=1
    fi
  else
    log "Installing $EXTENSION_ID"
  fi

  if [[ "$status" -eq 0 ]]; then
    run_in_repo "$repo" specify extension add --dev "$INSTALL_SOURCE" --priority "$PRIORITY" || status=1
  fi

  if [[ "$status" -eq 0 ]]; then
    merge_registry_state "$repo" "$backup_dir" || status=1
  fi

  if [[ "$status" -eq 0 ]]; then
    restore_project_config "$backup_dir" "$extension_dir" || status=1
  fi

  if [[ "$status" -eq 0 ]]; then
    ensure_lens_catalog "$repo" || status=1
  fi

  if [[ "$status" -eq 0 ]]; then
    run_in_repo "$repo" specify extension list || status=1
  fi

  if [[ "$DRY_RUN" -ne 1 ]]; then
    if [[ "$status" -eq 0 ]]; then
      rm -rf "$backup_dir"
    else
      restore_registry_state "$repo" "$backup_dir" || log "FAILED: could not restore extension registry from $backup_dir"
      log "FAILED: backup kept at $backup_dir"
    fi
  fi

  return "$status"
}

repos=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || die "--repo requires a path"
      repos+=("$2")
      shift 2
      ;;
    --source)
      [[ $# -ge 2 ]] || die "--source requires a path"
      EXTENSION_SOURCE="$2"
      shift 2
      ;;
    --priority)
      [[ $# -ge 2 ]] || die "--priority requires a number"
      PRIORITY="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      repos+=("$1")
      shift
      ;;
  esac
done

if [[ ${#repos[@]} -eq 0 ]]; then
  repos=("${REPOS[@]}")
fi

command -v specify >/dev/null 2>&1 || die "specify CLI is not on PATH"

if [[ ! "$PRIORITY" =~ ^[1-9][0-9]*$ ]]; then
  die "--priority must be a positive integer"
fi

EXTENSION_SOURCE="$(cd "$EXTENSION_SOURCE" && pwd -P)"
[[ -f "$EXTENSION_SOURCE/extension.yml" ]] || die "No extension.yml found in $EXTENSION_SOURCE"
trap cleanup_staged_source EXIT
stage_extension_source "$EXTENSION_SOURCE"

failures=0
for repo in "${repos[@]}"; do
  if ! install_or_update_repo "$repo"; then
    failures=$((failures + 1))
  fi
done

if [[ "$failures" -gt 0 ]]; then
  die "$failures repo(s) failed"
fi

log ""
log "Done."
