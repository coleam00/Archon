#!/usr/bin/env bash
# TEMPORARY (#5127): remove before the pull request is marked ready.
# Runs the three detached-timeout launcher tests in a fresh `bun test` process each time.
# usage: loop.sh <runs> <label> [--report-only]
set -u
runs=$1 label=$2 report_only=${3:-}
cd packages/cli
fail=0
for i in $(seq 1 "$runs"); do
  if out=$(bun test src/commands/workflow-file-store.integration.spec.ts -t 'launcher stops its detached' 2>&1); then
    echo "$label run $i: pass"
  else
    fail=$((fail + 1))
    echo "$label run $i: FAIL"
    echo "$out" | tail -60
  fi
done
echo "$label: $((runs - fail))/$runs passed on $(uname -s)"
if [ -z "$report_only" ] && [ "$fail" -ne 0 ]; then exit 1; fi
