#!/usr/bin/env bash
# Deploys Automaton Phase 8 (commit f7e57e9) to the VPS. Run as your own user (not root):
#   bash ~/deploy-phase8.sh
# Safe to rerun: if f7e57e9 is already deployed it only verifies. Live publishing stays OFF: this script never runs
# 'social connect', 'social live' or 'social run --live'. Business data in ~/.automaton-ventures is never modified.
#
# Steps: checks -> private backups (umask 077) -> verify commit -> build and test in a separate worktree ->
# switch (timer paused) -> verify (records unchanged, live off, dry run) -> restart timer -> one daily-service run.
# Any failure after the switch rolls the code back to the previous commit and restarts the timer.
set -Eeuo pipefail
umask 077

TARGET=f7e57e9f2340f095b532714a518ffb15136d6067
BRANCH=feature/social-publishing
APP="$HOME/automaton"; DATA="$HOME/.automaton-ventures"; BK="$HOME/automaton-backups"; NEXT="$HOME/automaton-next"
TIMER=automaton-daily.timer; SERVICE=automaton-daily.service
S=$(date +%Y%m%dT%H%M%S)
TMPD=""; SWITCHED=0; OLD=""; OLDREF=""

say()  { printf '\n== %s\n' "$*"; }
stop() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }
check() { "$@" || { printf 'check failed: %s\n' "$*" >&2; return 1; }; }
# CI=true: pnpm never waits for a terminal prompt (for example before re-creating node_modules).
pinstall() { CI=true pnpm install --frozen-lockfile; }
cleanup() {
  [ -n "$TMPD" ] && rm -rf "$TMPD"
  if [ -d "$NEXT" ]; then git -C "$APP" worktree remove --force "$NEXT" >/dev/null 2>&1 || true; fi
  git -C "$APP" worktree prune >/dev/null 2>&1 || true
}
rollback() {
  [ "$SWITCHED" = 1 ] || return 0
  printf '\n== ROLLING BACK to %s\n' "${OLDREF:-$OLD}" >&2
  if [ "$OLDREF" = HEAD ]; then git -C "$APP" checkout -q "$OLD"; else git -C "$APP" checkout -q "$OLDREF"; fi
  (cd "$APP" && pinstall && pnpm build) >"$BK/rollback-$S.log" 2>&1 || printf 'ROLLBACK BUILD FAILED: see %s\n' "$BK/rollback-$S.log" >&2
  systemctl --user start "$TIMER" || true
  printf 'Rolled back to %s; timer restarted. Data was not touched.\n' "$(git -C "$APP" log --oneline -1)" >&2
}
trap cleanup EXIT
# Act only in the main shell (subshells inherit the trap with -E and just exit with the error).
trap 'rc=$?; [ "$BASH_SUBSHELL" = 0 ] || exit "$rc"; rollback; stop "a step failed (exit $rc); see the messages above"' ERR

verify() {
  local v="node $APP/dist/venture-engine/main.js" status runout
  check test "$(git -C "$APP" rev-parse HEAD)" = "$TARGET"
  status=$($v social status)
  printf '%s\n' "$status"
  if printf '%s' "$status" | grep -q "live publishing ON"; then printf 'live publishing is ON: refusing\n' >&2; return 1; fi
  runout=$($v social run)
  printf '%s\n' "$runout"
  check grep -q "DRY RUN" <<<"$runout"
  systemctl --user is-active --quiet "$TIMER" || { printf 'the 08:00 timer is not active\n' >&2; return 1; }
  systemctl --user list-timers "$TIMER" --no-pager | head -3
}

say "Checks"
for c in git node pnpm systemctl journalctl tar sha256sum; do command -v "$c" >/dev/null || stop "missing command: $c"; done
[ "$(id -u)" != 0 ] || stop "run as your own user, not root"
[ -d "$APP/.git" ] && [ -d "$DATA" ] || stop "expected $APP (git) and $DATA"
cd "$APP"
if [ "$(git rev-parse HEAD)" = "$TARGET" ] && [ -f dist/venture-engine/main.js ]; then
  say "Already on f7e57e9: verifying only"
  trap - ERR; verify || stop "verification failed"; say "OK: Phase 8 deployed, live publishing off"; exit 0
fi
now=$(TZ=Europe/London date +%H%M)
if (( 10#$now >= 745 && 10#$now <= 815 )); then stop "too close to the 08:00 run; try again after 08:15 UK time"; fi
[ -z "$(git status --porcelain --untracked-files=no)" ] || { git status --short --untracked-files=no; stop "uncommitted changes in $APP"; }
OLD=$(git rev-parse HEAD); OLDREF=$(git rev-parse --abbrev-ref HEAD)
printf 'running version: %s (%s)\n' "$(git log --oneline -1)" "$OLDREF"

say "Private backups"
mkdir -p "$BK"; chmod 700 "$BK"; chmod 600 "$BK"/* 2>/dev/null || true
tar -czf "$BK/ventures-$S.tgz" -C "$HOME" .automaton-ventures
tar -czf "$BK/code-$S.tgz" --exclude=node_modules -C "$HOME" automaton
(cd "$DATA" && sha256sum ./*.json) > "$BK/records-$S.sha256"
printf 'S=%s\nOLD=%s\nOLDREF=%s\n' "$S" "$OLD" "$OLDREF" > "$BK/phase8-$S.env"
ls -l "$BK" | tail -4

say "Fetch and verify f7e57e9"
git fetch -q origin "$BRANCH"
check git cat-file -e "$TARGET^{commit}"
check git merge-base --is-ancestor "$TARGET" "origin/$BRANCH"
git merge-base --is-ancestor HEAD "$TARGET" || stop "the running version is not part of f7e57e9's history: not a fast-forward"
git log --oneline -1 "$TARGET"

say "Build and test in a separate worktree (running version untouched)"
cleanup
git worktree add -q --detach "$NEXT" "$TARGET"
(cd "$NEXT" && pinstall) >"$BK/next-install-$S.log" 2>&1 || stop "install failed (see $BK/next-install-$S.log); nothing was switched"
(cd "$NEXT" && pnpm build) >"$BK/next-build-$S.log" 2>&1 || stop "build failed (see $BK/next-build-$S.log); nothing was switched"
TMPD=$(mktemp -d)
(cd "$NEXT" && HOME="$TMPD" TMPDIR="$TMPD" ./node_modules/.bin/vitest run src/__tests__/venture-engine) >"$BK/next-test-$S.log" 2>&1 || { tail -20 "$BK/next-test-$S.log"; stop "tests failed (see $BK/next-test-$S.log); nothing was switched"; }
grep -E "Test Files|Tests " "$BK/next-test-$S.log" || true
rm -rf "$TMPD"; TMPD=""

say "Switch (timer paused)"
systemctl --user stop "$TIMER"
SWITCHED=1
git checkout -q -B "$BRANCH" "$TARGET"
if git diff --quiet "$OLD" "$TARGET" -- package.json pnpm-lock.yaml pnpm-workspace.yaml packages/cli/package.json; then
  echo "dependencies unchanged: no reinstall needed"
else
  (cd "$APP" && pinstall) >"$BK/install-$S.log" 2>&1
fi
(cd "$APP" && pnpm build) >"$BK/build-$S.log" 2>&1
(cd "$DATA" && sha256sum --quiet -c "$BK/records-$S.sha256")
systemctl --user start "$TIMER"

say "Verify"
verify
SWITCHED=0
trap - ERR

say "One run of the daily service"
systemctl --user start "$SERVICE" || printf 'note: the daily service reported a problem; see the journal below\n'
journalctl --user -u "$SERVICE" -n 8 --no-pager -o cat || true

say "DONE: f7e57e9 deployed; records unchanged; live publishing off; 08:00 timer active"
printf 'Backups: %s/ventures-%s.tgz and code-%s.tgz (private)\nRollback: git -C %s checkout -q %s && (cd %s && CI=true pnpm install --frozen-lockfile && pnpm build)\n' "$BK" "$S" "$S" "$APP" "${OLDREF/#HEAD/$OLD}" "$APP"
