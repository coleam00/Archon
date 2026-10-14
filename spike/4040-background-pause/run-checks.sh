#!/usr/bin/env bash
# Spike #4040: can a background or trigger-started run pause at `wait: attention`, be
# answered from another process, and continue cleanly? Throwaway; nothing here merges.
#
# Usage: run-checks.sh <sqlite|postgres> <evidence-dir>
#
# Every run uses a scratch ARCHON_HOME and a scratch git repo. The postgres backend
# initdb's a private cluster on PGPORT, creates the database, and drops it and stops the
# cluster on exit. Every process this script starts is recorded in <evidence-dir>/pids.txt
# and stopped by that PID. No workflow here makes an AI call.
#
# Checks 6 and 7 need a provider session and a failing platform send; they run in-process
# in packages/workflows/src/dag-executor.test.ts, not here.

set -u

BACKEND=${1:?usage: run-checks.sh <sqlite|postgres> <evidence-dir>}
OUT=${2:?usage: run-checks.sh <sqlite|postgres> <evidence-dir>}
case "$BACKEND" in sqlite | postgres) ;; *) echo "unknown backend: $BACKEND" >&2; exit 2 ;; esac

SPIKE_DIR=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "$SPIKE_DIR/../.." && pwd)
CLI="$SRC/packages/cli/src/cli.ts"
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@18/bin}
PGPORT=${PGPORT:-55440}
RACE_ROUNDS=${RACE_ROUNDS:-5}

mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
WORK=$(mktemp -d "/tmp/spike4040-$BACKEND.XXXX")
REPO=$WORK/repo
export ARCHON_HOME=$WORK/home
unset DATABASE_URL
PIDS=$OUT/pids.txt
RESULTS=$OUT/results.jsonl
LOG=$OUT/harness.log
: >"$PIDS"
: >"$RESULTS"
: >"$LOG"
PG_PID=""
HOST_PID=""

log() { echo "$*" | tee -a "$LOG"; }
# A PID is stopped only while it still names the process recorded: its start time is
# captured at record time, so a PID recorded at launch is never signalled once reused.
# reap_owner records at reap time, so there the guard relies on the PID still being the owner.
record_pid() {
  echo "$1 $2" >>"$PIDS"
  ps -o lstart= -p "$1" >"$WORK/pidstart-$1" 2>/dev/null
}

stop_pid() {
  local pid=$1
  kill -0 "$pid" 2>/dev/null || return 0
  [ -s "$WORK/pidstart-$pid" ] && [ "$(ps -o lstart= -p "$pid" 2>/dev/null)" = "$(cat "$WORK/pidstart-$pid")" ] || return 0
  kill "$pid" 2>/dev/null
  for _ in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25
  done
  log "pid $pid ignored SIGTERM; sending SIGKILL"
  kill -9 "$pid" 2>/dev/null
}

archon() { (cd "$REPO" && bun "$CLI" "$@" 2>>"$LOG"); }

sql() {
  if [ "$BACKEND" = sqlite ]; then
    sqlite3 "$ARCHON_HOME/archon.db" "$1"
  else
    "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT" -U spike -d spike4040 -At -c "$1"
  fi
}

count_events() { # run event [step]
  local step_clause=""
  [ $# -ge 3 ] && step_clause="and step_name = '$3'"
  sql "select count(*) from remote_agent_workflow_events where workflow_run_id = '$1' and event_type = '$2' $step_clause"
}

dump_events() {
  sql "select created_at, event_type, coalesce(step_name, ''), substr(cast(data as text), 1, 300) from remote_agent_workflow_events where workflow_run_id = '$1' order by created_at, id" \
    >"$OUT/events-$1.txt" 2>&1
}

result() { # check verdict detail
  jq -nc --arg backend "$BACKEND" --arg check "$1" --arg verdict "$2" --arg detail "$3" \
    '{backend: $backend, check: $check, verdict: $verdict, detail: $detail}' >>"$RESULTS"
  log "[$BACKEND] check $1: $2 - $3"
}

get_run() { archon workflow get "$1" --json; }
run_status() { get_run "$1" | jq -r '.status'; }
occurrence() { get_run "$1" | jq -r '.metadata.wait.pauseId // empty'; }
artifacts_dir() { echo "$(get_run "$1" | jq -r '.output_root')/artifacts/runs/$1"; }

wait_for_status() { # run status [seconds]
  local s=""
  for _ in $(seq 1 "${3:-60}"); do
    s=$(run_status "$1")
    [ "$s" = "$2" ] && return 0
    sleep 1
  done
  log "timeout: run $1 is '$s', wanted '$2'"
  return 1
}

# Wait for the next pause of a run: paused with an occurrence other than $2, or completed.
wait_for_next_pause() {
  local s occ
  for _ in $(seq 1 60); do
    s=$(run_status "$1")
    if [ "$s" = completed ]; then echo completed; return 0; fi
    if [ "$s" = paused ]; then
      occ=$(occurrence "$1")
      if [ -n "$occ" ] && [ "$occ" != "$2" ]; then echo "$occ"; return 0; fi
    fi
    sleep 1
  done
  echo timeout
}

start_detached() { archon workflow run "$1" --detach --no-worktree | sed -n 's/^Run id: //p'; }

start_host() {
  (cd "$REPO" && exec bun "$CLI" workflow wake --watch --json) >>"$OUT/host-$1.jsonl" 2>>"$LOG" &
  HOST_PID=$!
  record_pid "$HOST_PID" "continuation-host-$1"
}

stop_host() {
  [ -n "$HOST_PID" ] && stop_pid "$HOST_PID"
  HOST_PID=""
}

# Stop the detached owner the run recorded, if it is somehow still alive (invariant).
# A run the host continued records the host as its owner; the host is stopped separately.
reap_owner() {
  local pid
  pid=$(get_run "$1" | jq -r '.metadata.execution_owner.pid // empty')
  [ -z "$pid" ] || [ "$pid" = "$HOST_PID" ] && return 0
  record_pid "$pid" "execution-owner-$1"
  stop_pid "$pid"
}

cleanup() {
  stop_host
  # Postgres is stopped last, after its scratch database is dropped.
  while read -r pid _; do [ "$pid" = "$PG_PID" ] || stop_pid "$pid"; done <"$PIDS"
  if [ "$BACKEND" = postgres ] && [ -n "$PG_PID" ]; then
    "$PGBIN/dropdb" -h 127.0.0.1 -p "$PGPORT" -U spike spike4040 >>"$LOG" 2>&1 &&
      log "dropped scratch database spike4040"
    kill -INT "$PG_PID" 2>/dev/null
    for _ in $(seq 1 40); do kill -0 "$PG_PID" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$PG_PID" 2>/dev/null && log "postgres $PG_PID still alive" || log "stopped postgres $PG_PID"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- setup -----------------------------------------------------------------------------

if [ "$BACKEND" = postgres ]; then
  export LC_ALL=C LANG=C
  "$PGBIN/initdb" -D "$WORK/pg" -U spike -A trust --no-locale -E UTF8 >>"$LOG" 2>&1 || { log "initdb failed"; exit 1; }
  "$PGBIN/pg_ctl" -D "$WORK/pg" -l "$WORK/pg.log" -w \
    -o "-p $PGPORT -k $WORK -c listen_addresses=127.0.0.1" start >>"$LOG" 2>&1 ||
    { log "postgres failed to start"; cat "$WORK/pg.log" >>"$LOG"; exit 1; }
  PG_PID=$(head -1 "$WORK/pg/postmaster.pid")
  record_pid "$PG_PID" postgres
  "$PGBIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U spike spike4040 || exit 1
  export DATABASE_URL="postgres://spike@127.0.0.1:$PGPORT/spike4040"
fi

git init -q --bare "$WORK/origin.git"
mkdir -p "$REPO/.archon/workflows"
cp "$SPIKE_DIR"/workflows/*.yaml "$REPO/.archon/workflows/"
(cd "$REPO" && git init -q -b main && git add -A && git -c user.name=spike -c user.email=spike@example.invalid commit -qm spike &&
  git remote add origin "$WORK/origin.git" && git push -q origin main)
log "backend=$BACKEND work=$WORK source=$(git -C "$SRC" rev-parse --short HEAD)"

# --- check 1: a detached run pauses, its owner exits, the run stays paused and listed ---

R1=$(start_detached spike-select)
if [ -z "$R1" ] || ! wait_for_status "$R1" paused; then
  result 1 disproven "detached run '$R1' never reached paused"
  exit 1
fi
OWNER=$(get_run "$R1" | jq -r '.metadata.execution_owner.pid')
record_pid "$OWNER" "execution-owner-$R1"
owner_gone=no
for _ in $(seq 1 40); do
  kill -0 "$OWNER" 2>/dev/null || { owner_gone=yes; break; }
  sleep 0.25
done
[ "$owner_gone" = no ] && stop_pid "$OWNER"
get_run "$R1" >"$OUT/c1-run.json"
archon workflow status --json >"$OUT/c1-status.json"
listed=$(jq --arg id "$R1" '[.runs[] | select(.id == $id and .status == "paused")] | length' "$OUT/c1-status.json")
archon workflow wait "$R1" --json --timeout 5 >"$OUT/c1-wait.json"
wait_kind=$(jq -r '.attention.kind' "$OUT/c1-wait.json")
wait_occ=$(jq -r '.attention.occurrence' "$OUT/c1-wait.json")
OCC1=$(jq -r '.metadata.wait.pauseId' "$OUT/c1-run.json")
if [ "$owner_gone" = yes ] && [ "$listed" = 1 ] && [ "$wait_kind" = attention ] && [ "$wait_occ" = "$OCC1" ]; then
  result 1 proven "run $R1 paused; owner pid $OWNER exited by itself; listed paused by 'workflow status'; 'workflow wait' reports kind=attention occurrence=$OCC1"
else
  result 1 disproven "owner_gone=$owner_gone listed=$listed wait_kind=$wait_kind wait_occ=$wait_occ pauseId=$OCC1"
fi

# --- check 2: --json answer from another process; only a continuation host continues it ---

archon workflow answer "$R1" --occurrence "$OCC1" --choose go --text "answered from shell B" --json >"$OUT/c2-answer.json"
sleep 6
get_run "$R1" >"$OUT/c2-answered-no-host.json"
st_no_host=$(jq -r '.status' "$OUT/c2-answered-no-host.json")
via=$(jq -r '.metadata.wait.answeredVia // empty' "$OUT/c2-answered-no-host.json")
at=$(jq -r '.metadata.wait.answeredAt // empty' "$OUT/c2-answered-no-host.json")
start_host c2
wait_for_status "$R1" completed
st_host=$(run_status "$R1")
stop_host
after=$(cat "$(artifacts_dir "$R1")/after.txt" 2>/dev/null)
answered_events=$(count_events "$R1" wait_answered ask)
dump_events "$R1"
if [ "$st_no_host" = paused ] && [ "$st_host" = completed ] && [ "$via" = cli ] && [ -n "$at" ] &&
  [ "$after" = "decision='go' text='answered from shell B'" ] && [ "$answered_events" = 1 ]; then
  result 2 proven "answered via --json, run stayed paused with no host; wake --watch continued it to completed; next node read [$after]; answeredVia=$via answeredAt=$at; 1 wait_answered event"
else
  result 2 disproven "no_host=$st_no_host host=$st_host via=$via at=$at after=[$after] wait_answered=$answered_events"
fi

# --- check 3a: two answers race on one occurrence ---------------------------------------

race_ok=0
for i in $(seq 1 "$RACE_ROUNDS"); do
  R=$(start_detached spike-select)
  wait_for_status "$R" paused || continue
  reap_owner "$R"
  OCC=$(occurrence "$R")
  (archon workflow answer "$R" --occurrence "$OCC" --choose go --text racer-a --json >"$OUT/c3a-$i-a.json"; echo $? >"$OUT/c3a-$i-a.rc") &
  pa=$!
  (archon workflow answer "$R" --occurrence "$OCC" --choose stop --text racer-b --json >"$OUT/c3a-$i-b.json"; echo $? >"$OUT/c3a-$i-b.rc") &
  pb=$!
  record_pid "$pa" "answer-racer-a-$R"
  record_pid "$pb" "answer-racer-b-$R"
  wait "$pa" "$pb"
  oks=$(cat "$OUT/c3a-$i-a.json" "$OUT/c3a-$i-b.json" | jq -s '[.[] | select(.ok == true)] | length')
  start_host "c3a-$i"
  wait_for_status "$R" completed
  stop_host
  lines=$(wc -l <"$(artifacts_dir "$R")/after.txt" | tr -d ' ')
  answered=$(count_events "$R" wait_answered ask)
  after_runs=$(count_events "$R" node_started after)
  dump_events "$R"
  log "c3a round $i run $R: ok answers=$oks rc=$(cat "$OUT/c3a-$i-a.rc"),$(cat "$OUT/c3a-$i-b.rc") wait_answered=$answered after.node_started=$after_runs after.txt lines=$lines winner=[$(cat "$(artifacts_dir "$R")/after.txt")]"
  [ "$oks" = 1 ] && [ "$answered" = 1 ] && [ "$after_runs" = 1 ] && [ "$lines" = 1 ] && race_ok=$((race_ok + 1))
done
if [ "$race_ok" = "$RACE_ROUNDS" ]; then
  result 3a proven "$RACE_ROUNDS/$RACE_ROUNDS rounds: exactly one of two racing answers accepted, one wait_answered event, 'after' ran once"
else
  result 3a disproven "$race_ok/$RACE_ROUNDS rounds clean; see harness.log"
fi

# --- check 3b: a host scan races an inline CLI resume -----------------------------------

race_ok=0
for i in $(seq 1 "$RACE_ROUNDS"); do
  R=$(start_detached spike-select)
  wait_for_status "$R" paused || continue
  reap_owner "$R"
  archon workflow answer "$R" --occurrence "$(occurrence "$R")" --choose go --text "host-vs-resume" --json >/dev/null
  (archon workflow wake --json >"$OUT/c3b-$i-wake.json"; echo $? >"$OUT/c3b-$i-wake.rc") &
  pw=$!
  (archon workflow resume "$R" >"$OUT/c3b-$i-resume.out" 2>&1; echo $? >"$OUT/c3b-$i-resume.rc") &
  pr=$!
  record_pid "$pw" "wake-pass-$R"
  record_pid "$pr" "inline-resume-$R"
  wait "$pw" "$pr"
  wait_for_status "$R" completed 30
  final=$(run_status "$R")
  lines=$(wc -l <"$(artifacts_dir "$R")/after.txt" 2>/dev/null | tr -d ' ')
  after_runs=$(count_events "$R" node_started after)
  accepted=$(jq -r '.accepted' "$OUT/c3b-$i-wake.json" 2>/dev/null)
  dump_events "$R"
  log "c3b round $i run $R: final=$final wake.accepted=$accepted wake.rc=$(cat "$OUT/c3b-$i-wake.rc") resume.rc=$(cat "$OUT/c3b-$i-resume.rc") after.node_started=$after_runs after.txt lines=$lines"
  [ "$final" = completed ] && [ "$after_runs" = 1 ] && [ "$lines" = 1 ] && race_ok=$((race_ok + 1))
done
if [ "$race_ok" = "$RACE_ROUNDS" ]; then
  result 3b proven "$RACE_ROUNDS/$RACE_ROUNDS rounds: a one-shot 'workflow wake' racing 'workflow resume' after a --json answer produced exactly one execution of 'after'"
else
  result 3b disproven "$race_ok/$RACE_ROUNDS rounds clean; see harness.log"
fi

# --- check 3c: an inline (human-mode) answer while a host is watching -------------------

race_ok=0
start_host c3c
for i in $(seq 1 "$RACE_ROUNDS"); do
  R=$(start_detached spike-select)
  wait_for_status "$R" paused || continue
  reap_owner "$R"
  archon workflow answer "$R" --occurrence "$(occurrence "$R")" --choose go --text inline >"$OUT/c3c-$i-answer.out"
  echo $? >"$OUT/c3c-$i-answer.rc"
  wait_for_status "$R" completed 30
  final=$(run_status "$R")
  after_runs=$(count_events "$R" node_started after)
  lines=$(wc -l <"$(artifacts_dir "$R")/after.txt" 2>/dev/null | tr -d ' ')
  dump_events "$R"
  log "c3c round $i run $R: final=$final answer.rc=$(cat "$OUT/c3c-$i-answer.rc") after.node_started=$after_runs after.txt lines=$lines"
  [ "$final" = completed ] && [ "$after_runs" = 1 ] && [ "$lines" = 1 ] && race_ok=$((race_ok + 1))
done
stop_host
if [ "$race_ok" = "$RACE_ROUNDS" ]; then
  result 3c proven "$RACE_ROUNDS/$RACE_ROUNDS rounds: an inline CLI answer with wake --watch running produced exactly one execution of 'after'"
else
  result 3c disproven "$race_ok/$RACE_ROUNDS rounds clean; see harness.log"
fi

# --- check 4: a trigger-started run pauses and resumes ----------------------------------

RUNAS=$(archon trigger whoami | jq -r '.runAsUserId')
write_trigger() { # file sourceInstance workflow
  jq -n --arg src "$2" --arg wf "$3" --arg user "$RUNAS" --arg cwd "$REPO" '{
    version: 1, sourceInstanceId: $src,
    binding: {bindingId: $src, bindingRevision: null, hostId: "spike-host", runAsUserId: $user,
      resource: ("spike:" + $src), overlap: "queue",
      launch: {cwd: $cwd, workflowName: $wf, inputs: {}, isolation: {kind: "in-place"}}},
    schedule: {intervalSeconds: 3600, runAtLoad: false}}' >"$1"
}
write_trigger "$WORK/trigger-select.json" spike-4040-select spike-select
write_trigger "$WORK/trigger-gate.json" spike-4040-gate spike-gate

archon trigger fire --config "$WORK/trigger-select.json" >"$OUT/c4-fire-1.json"
T1=$(jq -r '.bindings[0].disposition.runId // empty' "$OUT/c4-fire-1.json")
if [ -z "$T1" ] || ! wait_for_status "$T1" paused; then
  result 4 disproven "trigger run '$T1' never paused; see c4-fire-1.json and trigger-run log"
  cp "$ARCHON_HOME"/logs/trigger-run-*.log "$OUT/" 2>/dev/null
else
  T1_OWNER=$(get_run "$T1" | jq -r '.metadata.execution_owner.pid // empty')
  t1_owner_gone=unknown
  if [ -n "$T1_OWNER" ]; then
    record_pid "$T1_OWNER" "trigger-execution-owner-$T1"
    t1_owner_gone=no
    for _ in $(seq 1 40); do
      kill -0 "$T1_OWNER" 2>/dev/null || { t1_owner_gone=yes; break; }
      sleep 0.25
    done
    [ "$t1_owner_gone" = no ] && stop_pid "$T1_OWNER"
  fi
  get_run "$T1" >"$OUT/c4-paused.json"
  # A second start of the same binding while the first is paused (slot policy is #4045).
  archon trigger fire --config "$WORK/trigger-select.json" >"$OUT/c4-fire-2.json"
  second=$(jq -r '.bindings[0].requestStatus' "$OUT/c4-fire-2.json")
  T2=$(jq -r '.bindings[0].disposition.requestId // empty' "$OUT/c4-fire-2.json")
  archon workflow answer "$T1" --occurrence "$(occurrence "$T1")" --choose go --text "trigger answer" --json >"$OUT/c4-answer.json"
  start_host c4
  wait_for_status "$T1" completed
  t1_final=$(run_status "$T1")
  t1_after=$(cat "$(artifacts_dir "$T1")/after.txt" 2>/dev/null)
  dump_events "$T1"
  # Releasing the slot lets a drain admit the queued second start.
  t2_final=none
  if [ -n "$T2" ]; then
    archon trigger drain --host spike-host >"$OUT/c4-drain.json"
    if wait_for_status "$T2" paused 60; then
      archon workflow answer "$T2" --occurrence "$(occurrence "$T2")" --choose stop --json >/dev/null
      wait_for_status "$T2" completed
    fi
    t2_final=$(run_status "$T2")
    reap_owner "$T2"
    dump_events "$T2"
  fi
  stop_host
  cp "$ARCHON_HOME"/logs/trigger-run-*.log "$OUT/" 2>/dev/null
  if [ "$t1_final" = completed ] && [ "$t1_after" = "decision='go' text='trigger answer'" ] && [ "$t1_owner_gone" != no ]; then
    result 4 proven "trigger run $T1 paused (owner pid ${T1_OWNER:-none} exited=$t1_owner_gone), answered via --json, continued by wake --watch to completed, next node read [$t1_after]; second start while paused was '$second', after the first completed a drain took it to '$t2_final'"
  else
    result 4 disproven "t1_final=$t1_final after=[$t1_after] owner_gone=$t1_owner_gone second=$second t2_final=$t2_final"
  fi
fi

(cd "$REPO" && bun "$CLI" trigger fire --config "$WORK/trigger-gate.json") >"$OUT/c4-fire-gate.json" 2>"$OUT/c4-fire-gate.err"
gate_receipt=$(grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' "$OUT/c4-fire-gate.err" | head -1)
[ -n "$gate_receipt" ] && archon trigger inspect "$gate_receipt" >"$OUT/c4-gate-inspect.json"
gate_refusal=$(jq -r '[.. | objects | .error? // empty | strings] | first // empty' "$OUT/c4-gate-inspect.json" 2>/dev/null | cut -c1-300)
gate_status=$(jq -r '.bindings[0].requestStatus // .bindings[0].status' "$OUT/c4-fire-gate.json" 2>/dev/null)
gate_run=$(jq -r '.bindings[0].disposition.runId // empty' "$OUT/c4-fire-gate.json" 2>/dev/null)
gate_run_status=none
if [ -n "$gate_run" ]; then
  sleep 5
  gate_run_status=$(run_status "$gate_run")
  get_run "$gate_run" >"$OUT/c4-gate-run.json"
  reap_owner "$gate_run"
fi
cp "$ARCHON_HOME"/logs/trigger-run-*.log "$OUT/" 2>/dev/null
gate_log=$(tr '\n' ' ' <"$ARCHON_HOME/logs/trigger-run-$gate_run.log" 2>/dev/null | cut -c1-300)
result 4-gate observed "trigger start of a workflow with an approval: gate -> fire stderr=[$(tr '\n' ' ' <"$OUT/c4-fire-gate.err" | cut -c1-200)] receipt error=[$gate_refusal] request=$gate_status run=${gate_run:-none} status=$gate_run_status log=[$gate_log]"

# --- checks 5 and 8: a loop ending in an attention wait, three rounds, host only ---------

start_host c58
L=$(start_detached spike-loop)
prev=""
stale_verdict="not reached"
OCC_ROUND1=none
rounds_answered=0
for round in 1 2 3; do
  occ=$(wait_for_next_pause "$L" "$prev")
  case "$occ" in completed | timeout) break ;; esac
  reap_owner "$L"
  if [ "$round" = 2 ]; then
    before=$(count_events "$L" wait_answered)
    archon workflow answer "$L" --occurrence "$OCC_ROUND1" --text stale --json >"$OUT/c5-stale.json" 2>&1
    stale_rc=$?
    stale_ok=$(jq -r '.ok' "$OUT/c5-stale.json" 2>/dev/null)
    after_events=$(count_events "$L" wait_answered)
    still=$(run_status "$L")
    still_occ=$(occurrence "$L")
    if [ "$stale_ok" = false ] && [ "$before" = "$after_events" ] && [ "$still" = paused ] && [ "$still_occ" = "$occ" ]; then
      stale_verdict=proven
    else
      stale_verdict=disproven
    fi
    log "c5: stale answer ok=$stale_ok rc=$stale_rc wait_answered $before->$after_events status=$still occurrence=$still_occ (current $occ, stale $OCC_ROUND1)"
  fi
  [ "$round" = 1 ] && OCC_ROUND1=$occ
  archon workflow answer "$L" --occurrence "$occ" --text "r$round" --json >"$OUT/c8-answer-$round.json"
  rounds_answered=$round
  prev=$occ
done
wait_for_status "$L" completed 60
loop_final=$(run_status "$L")
stop_host
reap_owner "$L"
rounds=$(cat "$(artifacts_dir "$L")/rounds.txt" 2>/dev/null | tr '\n' '|')
loop_answers=$(count_events "$L" wait_answered)
dump_events "$L"
result 5 "$stale_verdict" "loop run $L: an answer naming round 1's occurrence $OCC_ROUND1 during round 2 -> $(tr -d '\n' <"$OUT/c5-stale.json" | cut -c1-300)"
if [ "$loop_final" = completed ] && [ "$rounds_answered" = 3 ] && [ "$loop_answers" = 3 ]; then
  result 8 proven "loop run $L: 3 rounds answered through --json, continued by wake --watch alone, completed; rounds.txt=[$rounds]"
else
  result 8 disproven "final=$loop_final rounds_answered=$rounds_answered wait_answered=$loop_answers rounds.txt=[$rounds]"
fi

log "done; results in $RESULTS"
