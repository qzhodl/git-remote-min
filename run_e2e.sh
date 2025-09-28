#!/usr/bin/env bash
# Pure Git E2E for min:// helper (FF-only server). No HTTP probes.
# Automated cases: 0,1,2,3,4,5. (others are manual as discussed)

set -u

# ---------- Config ----------
HOST="localhost:8080"
REPO="myrepo-$(date +%s)-$RANDOM"
REMOTE_URL="min://$HOST/$REPO"
ROOT="/tmp/min-remote-e2e-$RANDOM"
A="$ROOT/A"
B="$ROOT/B"
LOG="$ROOT/test.log"

# ---------- Tiny harness ----------
PASS=0; FAIL=0
mkdir -p "$ROOT"; : > "$LOG"

step() {
  echo
  echo "### $*"
  echo "### $*" >>"$LOG"
}
ok() {
  echo "    PASS: $*"
  echo "PASS: $*" >>"$LOG"
  ((PASS++)) || true
  return 0
}
ko() {
  echo "    FAIL: $*"
  echo "FAIL: $*" >>"$LOG"
  ((FAIL++)) || true
  return 1
}
run() {
  echo ">> $*" >>"$LOG"
  "$@" >>"$LOG" 2>&1
  rc=$?
  if [ $rc -ne 0 ]; then
    ko "cmd failed: $* (see $LOG)" >/dev/null || true
  fi
  return $rc
}
expect_fail() {
  echo ">> (expect fail) $*" >>"$LOG"
  "$@" >>"$LOG" 2>&1
  rc=$?
  if [ $rc -ne 0 ]; then
    ok "failed as expected: $*"
  else
    ko "unexpected success: $*"
  fi
  return 0
}

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1"; exit 1; }; }
need git
command -v git-remote-min >/dev/null 2>&1 || { echo "git-remote-min not in PATH"; exit 1; }

# Compare refs across repos
eq_ref() {
  local repo1="$1" ref1="$2" repo2="$3" ref2="$4"
  [ "$(git -C "$repo1" rev-parse "$ref1")" = "$(git -C "$repo2" rev-parse "$ref2")" ]
}

# ---------- CASE 0: init A and first push to main ----------
step "CASE 0: init A and first push to main"
mkdir -p "$A" && run git -C "$A" init -b main
echo "hello" > "$A/a.txt"
run git -C "$A" add a.txt
run git -C "$A" commit -m "init"
run git -C "$A" remote add origin "$REMOTE_URL"
run git -C "$A" push -u origin main
if git -C "$A" rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1; then
  ok "upstream set for A/main"
else
  ko "failed to set upstream"
fi

# ---------- CASE 1: A pushes one commit; B clone/fetch+merge ----------
step "CASE 1: incremental push/fetch"
mkdir -p "$B" && run git clone "$REMOTE_URL" "$B"
echo "v2" >> "$A/a.txt"
run git -C "$A" add a.txt
run git -C "$A" commit -m "v2"
run git -C "$A" push
run git -C "$B" fetch origin
run git -C "$B" merge origin/main
if eq_ref "$A" HEAD "$B" HEAD; then ok "B tip == A tip after merge"; else ko "B tip != A tip"; fi

# ---------- CASE 2: A makes 3 commits then one push; B fetch once ----------
step "CASE 2: batch commits then single push; B fetch once"
for i in 1 2 3; do
  echo "batch-$i" >> "$A/batches.txt"
  run git -C "$A" add batches.txt
  run git -C "$A" commit -m "batch $i"
done
run git -C "$A" push
run git -C "$B" fetch origin
run git -C "$B" merge origin/main
if eq_ref "$A" HEAD "$B" HEAD; then ok "B caught up with A batch tip"; else ko "B not at A batch tip"; fi

# ---------- CASE 3: A creates feature/x and pushes; B fetches only that ref ----------
step "CASE 3: feature/x push/fetch (targeted)"
run git -C "$A" switch -c feature/x
echo "feat" > "$A/feature.txt"
run git -C "$A" add feature.txt
run git -C "$A" commit -m "feature x"
run git -C "$A" push -u origin feature/x
run git -C "$B" fetch origin refs/heads/feature/x:refs/remotes/origin/feature/x
if git -C "$B" rev-parse --verify -q refs/remotes/origin/feature/x >/dev/null; then
  ok "B has origin/feature/x"
else
  ko "B missing origin/feature/x"
fi

# ---------- CASE 4: NonFastForward on main then rebase (no conflict) ----------
step "CASE 4: NonFastForward on main then rebase (no conflict)"
run git -C "$A" switch main
echo "advance-main" >> "$A/a.txt"
run git -C "$A" add a.txt
run git -C "$A" commit -m "advance main"
run git -C "$A" push origin main

run git -C "$B" switch main
echo "B-local-change" >> "$B/b_local.txt"
run git -C "$B" add b_local.txt
run git -C "$B" commit -m "B local change"
expect_fail git -C "$B" push origin main

run git -C "$B" fetch origin
run git -C "$B" rebase origin/main
run git -C "$B" push origin main
run git -C "$A" fetch origin
if eq_ref "$B" HEAD "$A" refs/remotes/origin/main; then ok "remote/main == B after rebase push"; else ko "remote/main != B head"; fi

# ---------- CASE 5: tag push/fetch ----------
step "CASE 5: tag push/fetch"
run git -C "$A" switch main
run git -C "$A" tag -a v0.1 -m "first tag"
run git -C "$A" push origin v0.1
run git -C "$B" fetch origin tag v0.1
if git -C "$B" rev-parse --verify -q v0.1 >/dev/null; then
  ok "B has tag v0.1"
else
  ko "B missing tag v0.1"
fi

# ---------- Summary & conditional cleanup ----------
echo
echo "RESULT: PASS=$PASS FAIL=$FAIL (repo=$REPO)"
echo "Log: $LOG"

if [ "$FAIL" -eq 0 ]; then
  echo "All tests passed. Cleaning up..."
  rm -rf "$ROOT"
  rm -rf "./data/$REPO" 2>/dev/null || true
  exit 0
else
  echo "Some tests failed. Keeping:"
  echo "  workspace: $ROOT"
  echo "  log:       $LOG"
  echo "  server dir: ./data/$REPO (if applicable)"
  exit 1
fi