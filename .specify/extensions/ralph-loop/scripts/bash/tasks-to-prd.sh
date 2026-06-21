#!/usr/bin/env bash
# tasks-to-prd.sh — convert spec-kit tasks.md to ralph prd.json + progress.txt
#
# Usage: tasks-to-prd.sh <feature-dir-or-prefix>
#   feature-dir-or-prefix: e.g. "004" or "004-sessions-memory-auth"
#
# Always (re)generates prd.json and progress.txt for the resolved feature dir,
# overwriting any existing files.
#
# Exits:
#   0  success — prd.json + progress.txt written (existing files overwritten)
#   2  guard failure (branch protected / ambiguous feature / missing tasks.md)

set -euo pipefail

FEATURE="${1:-}"
if [ -z "$FEATURE" ]; then
  if [ -f .specify/feature.json ]; then
    FEATURE=$(jq -r '.feature_directory // empty' .specify/feature.json | sed 's#^specs/##')
  fi
fi
if [ -z "$FEATURE" ]; then
  echo "[error] feature dir required (e.g. 004 or 004-sessions-memory-auth) — pass as \$1 or set feature_directory in .specify/feature.json" >&2
  exit 2
fi

# --- guard: branch must not be main/master --------------------------------
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
case "$(echo "$BRANCH" | tr '[:upper:]' '[:lower:]')" in
  main|master)
    echo "[refuse] branch '$BRANCH' is protected — checkout a feature branch first" >&2
    exit 2
    ;;
esac

# --- resolve feature directory -------------------------------------------
# Accept "004" or "004-foo"; refuse on 0 or 2+ matches.
matches=()
while IFS= read -r d; do
  matches+=("$d")
done < <(find specs -maxdepth 1 -mindepth 1 -type d -name "${FEATURE}*" 2>/dev/null | sort)

case "${#matches[@]}" in
  0) echo "[error] no spec dir matches 'specs/${FEATURE}*'" >&2; exit 2 ;;
  1) SPEC_DIR="${matches[0]}" ;;
  *)
    {
      echo "[error] feature prefix '$FEATURE' is ambiguous — matches:"
      printf '  %s\n' "${matches[@]}"
    } >&2
    exit 2
    ;;
esac

TASKS="$SPEC_DIR/tasks.md"
[ -f "$TASKS" ] || { echo "[error] tasks.md missing at $TASKS" >&2; exit 2; }

# --- extract project description (frontmatter) + header -------------------
# frontmatter lives between the leading --- ... --- block.
PROJECT=$(awk '
  BEGIN { in_fm=0 }
  /^---$/ { in_fm = !in_fm; next }
  in_fm && /^description:/ {
    sub(/^description:[[:space:]]*/, "");
    gsub(/^"|"$/, "");
    print; exit
  }
' "$TASKS")
if [ -z "$PROJECT" ]; then
  PROJECT="$(basename "$SPEC_DIR")"
fi

# Top-level "# Tasks: ..." header text → description.
DESC=$(awk '
  /^# Tasks:[[:space:]]/ {
    sub(/^# Tasks:[[:space:]]*/, "");
    print; exit
  }
' "$TASKS")
if [ -z "$DESC" ]; then
  DESC="$PROJECT"
fi

# --- parse task lines into TSV --------------------------------------------
# Output columns (tab-separated):
#   1: batch_key (sortable integer = phase * 1000 + subgroup; phase-only = subgroup 0)
#   2: batch_title — see batching rule below
#   3: id (T<NNN>)
#   4: position (1-based, document order across all phases)
#   5: has-test-flag (1 if line text matches /test|spec/i, else 0)
#   6: full task text (with [P] kept, but checkbox + id stripped from lead)
#
# Batching rule (v3.1):
#   - On `## Phase N: <title>` → phase++, subgroup=0, store phase_title.
#   - On `### <subtitle>` (only when in a phase) → subgroup++, store subgroup_title.
#   - For each `- [ ] T<NNN>` task:
#       - If the active phase has NOT yet seen a `###` (subgroup == 0) →
#         the batch is the whole phase; batch_title = phase_title.
#       - If the active phase HAS seen one or more `###` (subgroup >= 1) →
#         the batch is the current sub-group; batch_title = "Phase N.M: <subtitle>".
#   - group_by(batch_key) in jq nests tasks under their batch.
TSV=$(awk '
  BEGIN { phase=0; phase_title=""; subgroup=0; subgroup_title=""; pos=0 }
  /^##[[:space:]]+Phase[[:space:]]+[0-9]+/ {
    phase++
    subgroup=0
    subgroup_title=""
    hdr=$0
    sub(/^##[[:space:]]+/, "", hdr)
    gsub(/\t/, "    ", hdr)
    phase_title=hdr
    next
  }
  /^###[[:space:]]+/ {
    # Sub-section header. Only meaningful inside a Phase; ignore otherwise.
    if (phase == 0) next
    subgroup++
    hdr=$0
    sub(/^###[[:space:]]+/, "", hdr)
    gsub(/\t/, "    ", hdr)
    subgroup_title=hdr
    next
  }
  /^[[:space:]]*-[[:space:]]+\[[ xX]\][[:space:]]+T[0-9][0-9][0-9]/ {
    # Only convert unchecked tasks. Pre-existing [X] are skipped.
    if ($0 !~ /^[[:space:]]*-[[:space:]]+\[ \]/) next
    pos++
    line=$0
    # Extract T<NNN>
    n=split(line, f, /[[:space:]]+/)
    id=""
    for (i=1; i<=n; i++) if (f[i] ~ /^T[0-9][0-9][0-9]$/) { id=f[i]; break }
    if (id == "") next
    # Strip leading "- [ ] T<NNN>" to get task text
    text=line
    sub(/^[[:space:]]*-[[:space:]]+\[ \][[:space:]]+T[0-9][0-9][0-9][[:space:]]*/, "", text)
    # Replace embedded tabs with 4 spaces (TSV safety)
    gsub(/\t/, "    ", text)
    has_test=(tolower(text) ~ /test|spec/) ? 1 : 0
    if (phase == 0) { phase=1; phase_title="Phase 1" }  # tasks before any "## Phase" header

    # Compose batch_key + batch_title per the rule above.
    batch_key = phase * 1000 + subgroup
    if (subgroup == 0) {
      batch_title = phase_title
    } else {
      batch_title = sprintf("Phase %d.%d: %s", phase, subgroup, subgroup_title)
    }
    printf "%d\t%s\t%s\t%d\t%d\t%s\n", batch_key, batch_title, id, pos, has_test, text
  }
' "$TASKS")

if [ -z "$TSV" ]; then
  echo "[error] no '- [ ] T<NNN> ...' lines found in $TASKS" >&2
  exit 2
fi

# --- build prd.json with jq (v3 nested schema) ---------------------------
# Shape:
#   userStories: [ { title, completed, tasks: [...], tasksIds: [...] }, ... ]
# Each ## Phase header becomes one userStory batch. Phases with zero
# unchecked tasks are dropped (group_by skips empty buckets implicitly).
PRD="$SPEC_DIR/prd.json"
PROGRESS="$SPEC_DIR/progress.txt"

printf '%s\n' "$TSV" | jq -nR \
  --arg project "$PROJECT" \
  --arg branch "$BRANCH" \
  --arg desc "$DESC" \
  --arg spec_dir "$SPEC_DIR" \
  '
    {
      project: $project,
      branchName: $branch,
      description: $desc,
      specDirectory: $spec_dir,
      userStories:
        ( [ inputs
            | select(length > 0)
            | split("\t") as $r
            | {
                batch_key:   ($r[0] | tonumber),
                batch_title: $r[1],
                id:          $r[2],
                pos:         ($r[3] | tonumber),
                has_test:    ($r[4] | tonumber),
                text:        $r[5]
              }
          ]
          | group_by(.batch_key)
          | map({
              title:     .[0].batch_title,
              completed: false,
              tasks: map({
                id:          .id,
                title:       (.text | .[0:80] | sub("[[:space:]]+\\[P\\]$"; "")),
                description: .text,
                acceptanceCriteria:
                  ( ["Typecheck passes"]
                    + (if .has_test == 1 then ["Tests pass"] else [] end) ),
                priority:    .pos,
                passes:      false,
                notes:       ""
              }),
              tasksIds: map(.id)
            })
        )
    }
  ' > "$PRD"

# --- write empty progress.txt --------------------------------------------
: > "$PROGRESS"

# --- persist PRD/progress paths to .specify/feature.json -----------------
# ralph.sh resolves these when no env-var override is set, so the user
# only has to type the consent var on the command line.
FEATURE_JSON=".specify/feature.json"
if [ -f "$FEATURE_JSON" ]; then
  TMP=$(mktemp)
  jq --arg prd "$PRD" --arg progress "$PROGRESS" \
     '. + {ralph_prd_file: $prd, ralph_progress_file: $progress}' \
     "$FEATURE_JSON" > "$TMP" && mv "$TMP" "$FEATURE_JSON"
fi

# --- echo run instructions to stdout -------------------------------------
COUNT=$(jq '.userStories | length' "$PRD")
cat <<EOF

prd.json + progress.txt written to: $SPEC_DIR
userStories: $COUNT (priority 1..$COUNT)
feature.json updated: ralph_prd_file, ralph_progress_file

Open a separate terminal and run:

  RALPH_I_UNDERSTAND_DANGEROUS=1 bash .specify/extensions/ralph-loop/ralph.sh --tool claude 50

When ralph exits, run /speckit.ralph-loop.sync-back $FEATURE to flip [X] in tasks.md.
EOF
