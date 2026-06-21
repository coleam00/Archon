#!/usr/bin/env bash
set -Eeuo pipefail

# Build/install this Spec Kit extension into local consumer repositories.
# "Build" here means stage a clean copy of the extension source, then install
# that staged copy with `specify extension add --dev`.

DEFAULT_REPOS=(
  "/Users/dale/Desktop/workspace/OceanLabs/x10.oh.cowork"
  "/Users/dale/Desktop/workspace/OceanLabs/workflow-engine/no-mistakes"
  /Users/dale/Desktop/workspace/OceanLabs/workflow-engine/Archon
)

EXTENSION_ID="ralph-loop"
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

Stages this extension and installs or updates it in Spec Kit project(s).
If no repo is supplied, the default target is:
  ${DEFAULT_REPOS[*]}

Options:
  --repo PATH       Install/update one repo. Can be passed multiple times.
  --source PATH     Extension source directory. Default: this repo.
  --priority N      Extension priority for specify. Default: ${PRIORITY}
  --dry-run         Print actions without changing files.
  -h, --help        Show this help.
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

make_dir() {
  local directory="$1"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '+ mkdir -p %q\n' "$directory"
    return 0
  fi

  mkdir -p "$directory"
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

copy_optional_file() {
  local source="$1"
  local destination="$2"

  [[ -f "$source" ]] || return 0
  copy_file "$source" "$destination"
}

stage_extension_source() {
  local source="$1"
  local ignore_file="$source/.extensionignore"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    INSTALL_SOURCE="${TMPDIR:-/tmp}/speckit-$EXTENSION_ID-source.DRYRUN/source"
    printf '+ mkdir -p %q\n' "$INSTALL_SOURCE"
    printf '+ rsync -a --delete --exclude .git/ --exclude .omx/ --exclude .DS_Store'
    if [[ -f "$ignore_file" ]]; then
      printf ' --exclude-from %q' "$ignore_file"
    fi
    printf ' %q/ %q/\n' "$source" "$INSTALL_SOURCE"
    return 0
  fi

  command -v rsync >/dev/null 2>&1 || die "rsync is required to stage extension source"

  STAGED_SOURCE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/speckit-$EXTENSION_ID-source.XXXXXX")"
  INSTALL_SOURCE="$STAGED_SOURCE_DIR/source"
  mkdir -p "$INSTALL_SOURCE"

  local rsync_args=(
    -a
    --delete
    --exclude='.git/'
    --exclude='.omx/'
    --exclude='.DS_Store'
  )
  if [[ -f "$ignore_file" ]]; then
    rsync_args+=(--exclude-from="$ignore_file")
  fi

  rsync "${rsync_args[@]}" "$source"/ "$INSTALL_SOURCE"/
}

cleanup_staged_source() {
  if [[ "$DRY_RUN" -ne 1 && -n "$STAGED_SOURCE_DIR" ]]; then
    rm -rf "$STAGED_SOURCE_DIR"
  fi
}

extension_is_installed() {
  local repo="$1"
  local registry="$repo/.specify/extensions/.registry"

  if command -v jq >/dev/null 2>&1 && [[ -f "$registry" ]]; then
    jq -e --arg id "$EXTENSION_ID" '.extensions[$id] != null' "$registry" >/dev/null 2>&1 && return 0
  fi

  [[ -f "$repo/.specify/extensions/$EXTENSION_ID/extension.yml" ]]
}

backup_project_config() {
  local extension_dir="$1"
  local backup_dir="$2"

  [[ -d "$extension_dir" ]] || return 0
  make_dir "$backup_dir"

  copy_optional_file "$extension_dir/ralph-config.yml" "$backup_dir/ralph-config.yml"
  copy_optional_file "$extension_dir/ralph-config.local.yml" "$backup_dir/ralph-config.local.yml"
  copy_optional_file "$extension_dir/.consent" "$backup_dir/.consent"
}

restore_project_config() {
  local backup_dir="$1"
  local extension_dir="$2"

  [[ -d "$backup_dir" ]] || return 0
  make_dir "$extension_dir"

  copy_optional_file "$backup_dir/ralph-config.yml" "$extension_dir/ralph-config.yml"
  copy_optional_file "$backup_dir/ralph-config.local.yml" "$extension_dir/ralph-config.local.yml"
  copy_optional_file "$backup_dir/.consent" "$extension_dir/.consent"
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
  merged_registry="$(mktemp "${TMPDIR:-/tmp}/speckit-$EXTENSION_ID-registry.XXXXXX")"

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

ensure_installed_files() {
  local repo="$1"
  local extension_dir="$repo/.specify/extensions/$EXTENSION_ID"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '+ test -f %q\n' "$extension_dir/extension.yml"
    printf '+ test -x %q\n' "$extension_dir/ralph.sh"
    printf '+ test -x %q\n' "$extension_dir/scripts/bash/tasks-to-prd.sh"
    printf '+ test -x %q\n' "$extension_dir/scripts/bash/sync-passes-to-tasks.sh"
    return 0
  fi

  [[ -f "$extension_dir/extension.yml" ]] || die "install did not create $extension_dir/extension.yml"
  [[ -f "$extension_dir/ralph.sh" ]] || die "install did not create $extension_dir/ralph.sh"
  [[ -x "$extension_dir/ralph.sh" ]] || chmod +x "$extension_dir/ralph.sh"
  [[ -x "$extension_dir/scripts/bash/tasks-to-prd.sh" ]] || chmod +x "$extension_dir/scripts/bash/tasks-to-prd.sh"
  [[ -x "$extension_dir/scripts/bash/sync-passes-to-tasks.sh" ]] || chmod +x "$extension_dir/scripts/bash/sync-passes-to-tasks.sh"

  if [[ ! -f "$extension_dir/ralph-config.yml" && -f "$extension_dir/ralph-config.template.yml" ]]; then
    copy_file "$extension_dir/ralph-config.template.yml" "$extension_dir/ralph-config.yml"
  fi
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
    backup_dir="$(mktemp -d "${TMPDIR:-/tmp}/speckit-$EXTENSION_ID.XXXXXX")"
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
    ensure_installed_files "$repo" || status=1
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
  repos=("${DEFAULT_REPOS[@]}")
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
