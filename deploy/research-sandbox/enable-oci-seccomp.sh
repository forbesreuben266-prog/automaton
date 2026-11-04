#!/usr/bin/env bash
# V2.4: make gVisor (runsc) load the container's seccomp profile inside the
# sandbox by registering runsc with exactly one runtime flag, --oci-seccomp.
#
# Why: runsc ignores the OCI seccomp profile unless --oci-seccomp is set
# (gVisor release-20261102.0, runsc/boot/seccomp.go; flag default false), so
# the sandbox canary sees seccomp mode 0. The preflight requires mode 2 and,
# from V2.4, requires runsc to be registered with exactly ["--oci-seccomp"].
#
# DRY RUN by default: shows the current runsc registration and the planned
# change; nothing is written.
#     sudo bash deploy/research-sandbox/enable-oci-seccomp.sh
#     sudo bash deploy/research-sandbox/enable-oci-seccomp.sh --execute
#     bash deploy/research-sandbox/enable-oci-seccomp.sh --check-config=<file>   # dry run on a copy
#
# --execute changes ONE thing: in /etc/docker/daemon.json, runtimes.runsc gets
# "runtimeArgs": ["--oci-seccomp"]. Everything else in the file is kept
# exactly. A timestamped backup is written first. Docker is then RELOADED
# (systemctl reload docker: SIGHUP, which re-reads runtimes; running
# containers are not restarted) and docker info is checked. It refuses if the
# runsc entry has any other key or flag, or a path other than /usr/bin/runsc.
# No download, no package change, no container is created.

set -u
set -o pipefail

CONF=/etc/docker/daemon.json
RUNSC=/usr/bin/runsc
DOCKER=/usr/bin/docker
FLAG='--oci-seccomp'
EXECUTE=0
CHECK=""
for arg in "$@"; do
  case "$arg" in
    --execute) EXECUTE=1 ;;
    --check-config=*) CHECK="${arg#--check-config=}" ;;
    *) echo "Usage error: unknown argument '$arg'"; exit 2 ;;
  esac
done
if [ "$EXECUTE" = 1 ] && [ -n "$CHECK" ]; then echo "Usage error: --check-config is a dry run only"; exit 2; fi
[ -n "$CHECK" ] && CONF="$CHECK"

say() { echo "$*"; }
die() { echo "STOP  $*"; exit 1; }
NODE_BIN="$(command -v node)" || die "node is required (Node 22)"

# Reads the config from the environment (J_IN), prints the new config, or exits 3 if already done.
# Refuses (exit 1, message on stderr) on anything unexpected, including a key repeated in one object
# (JSON.parse would silently keep only the last one).
plan_change() {
  J_IN="$1" "$NODE_BIN" -e '
    const [runsc, flag] = process.argv.slice(1);
    const fail = (m) => { process.stderr.write(m); process.exit(1); };
    let c; try { c = JSON.parse(process.env.J_IN); } catch { fail("daemon.json is not valid JSON"); }
    // The text is valid JSON here; scan it for a key repeated within one object.
    const duplicateKey = (t) => {
      const stack = [];
      for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        if (ch === "\"") {
          let j = i + 1;
          while (t[j] !== "\"") j += t[j] === "\\" ? 2 : 1;
          const top = stack[stack.length - 1];
          if (top && top.expectKey) {
            const key = JSON.parse(t.slice(i, j + 1));
            if (top.keys.has(key)) return key;
            top.keys.add(key);
            top.expectKey = false;
          }
          i = j;
        } else if (ch === "{") stack.push({ keys: new Set(), expectKey: true });
        else if (ch === "[") stack.push(null);
        else if (ch === "}" || ch === "]") stack.pop();
        else if (ch === ",") { const top = stack[stack.length - 1]; if (top) top.expectKey = true; }
      }
      return null;
    };
    const dup = duplicateKey(process.env.J_IN);
    if (dup !== null) fail("daemon.json repeats the key " + JSON.stringify(dup).slice(0, 80) + " in one object (ambiguous; fix it by hand first)");
    const obj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
    if (!obj(c)) fail("daemon.json is not a JSON object");
    if (!obj(c.runtimes) || !obj(c.runtimes.runsc)) fail("daemon.json has no runtimes.runsc entry (register runsc first)");
    const r = c.runtimes.runsc;
    const extra = Object.keys(r).filter((k) => k !== "path" && k !== "runtimeArgs");
    if (extra.length) fail("runtimes.runsc has other keys: " + extra.join(", "));
    if (r.path !== runsc) fail("runtimes.runsc.path is " + JSON.stringify(r.path) + ", not " + runsc);
    const args = r.runtimeArgs;
    if (JSON.stringify(args) === JSON.stringify([flag])) process.exit(3);
    if (!(args === undefined || (Array.isArray(args) && args.length === 0))) fail("runtimes.runsc.runtimeArgs already has other flags: " + JSON.stringify(args));
    const next = JSON.parse(JSON.stringify(c));
    next.runtimes.runsc = { path: runsc, runtimeArgs: [flag] };
    // Only runtimes.runsc may differ.
    const strip = (x) => { const y = JSON.parse(JSON.stringify(x)); delete y.runtimes.runsc; return JSON.stringify(y); };
    if (strip(next) !== strip(c)) fail("internal: the change would touch more than runtimes.runsc");
    process.stdout.write(JSON.stringify(next, null, 2) + "\n");
  ' "$RUNSC" "$FLAG"
}

# True when the RUNNING daemon reports runsc at $RUNSC with exactly [$FLAG] (polls up to 10 s after a reload).
active_ok() {
  local tries="$1" got
  for _ in $(seq 1 "$tries"); do
    got="$("$DOCKER" --host unix:///var/run/docker.sock info --format '{{json .Runtimes.runsc}}' 2>/dev/null)" || got=""
    if J_IN="$got" "$NODE_BIN" -e 'const r=JSON.parse(process.env.J_IN||"null");process.exit(r&&r.path===process.argv[1]&&JSON.stringify(r.runtimeArgs)===JSON.stringify([process.argv[2]])?0:1)' "$RUNSC" "$FLAG" 2>/dev/null; then
      return 0
    fi
    [ "$tries" -gt 1 ] && sleep 1
  done
  return 1
}

say "Enable gVisor in-sandbox seccomp: runtimes.runsc.runtimeArgs = [\"$FLAG\"] in $CONF"
if [ "$EXECUTE" = 1 ] && [ "$(id -u)" != 0 ]; then die "--execute must run as root (sudo)"; fi
[ -e "$CONF" ] || die "$CONF does not exist"
[ -L "$CONF" ] && die "$CONF is a symbolic link"
[ -f "$CONF" ] || die "$CONF is not a regular file"
# Owner and mode, failing closed if stat fails or prints anything unexpected.
OWNER="$(stat -c %u -- "$CONF")" && [[ "$OWNER" =~ ^[0-9]+$ ]] || die "cannot read the owner of $CONF"
MODE="$(stat -c %a -- "$CONF")" && [[ "$MODE" =~ ^[0-7]{3,4}$ ]] || die "cannot read the mode of $CONF"
[ $(( 8#$MODE & 8#022 )) = 0 ] || die "$CONF is writable by group or others (mode $MODE)"
[ -n "$CHECK" ] || [ "$OWNER" = 0 ] || die "$CONF is not owned by root"
CURRENT="$(cat -- "$CONF")" || die "cannot read $CONF"
NEW="$(plan_change "$CURRENT")"; RC=$?
if [ "$RC" = 3 ]; then
  say "  ok    $CONF already registers runsc with exactly [\"$FLAG\"]; the file needs no change"
  if [ "$EXECUTE" = 0 ]; then
    say ""
    say "DRY RUN: nothing was checked against the running daemon. --execute verifies docker info (and reloads only if it is not active yet)."
    exit 0
  fi
  [ -x "$DOCKER" ] || die "$DOCKER is not an executable file"
  if active_ok 1; then say "  ok    docker info: runsc at $RUNSC with runtimeArgs [\"$FLAG\"] (active)"; say ""; say "PASS: already enabled and active; nothing was changed."; exit 0; fi
  say "  note  the running daemon does not report it yet: reloading Docker (the file is not changed)"
  systemctl reload docker || die "systemctl reload docker failed; $CONF was not changed"
  active_ok 10 || die "docker info still does not show runsc with [\"$FLAG\"] after the reload; $CONF was not changed (check the Docker logs)"
  say "  ok    docker info: runsc at $RUNSC with runtimeArgs [\"$FLAG\"] (active after reload)"; say ""; say "PASS: enabled and active; $CONF was not changed."
  exit 0
fi
[ "$RC" = 0 ] || die "refusing to change $CONF (see the message above)"
say "  plan  new $CONF (only runtimes.runsc changes):"
printf '%s\n' "$NEW" | sed 's/^/        /'

if [ "$EXECUTE" = 0 ]; then
  say ""
  say "DRY RUN: nothing was written. Re-run with --execute (as root) after approval."
  exit 0
fi

[ -x "$RUNSC" ] || die "$RUNSC is not an executable file"
[ -x "$DOCKER" ] || die "$DOCKER is not an executable file"
BACKUP="$CONF.bak-$(date -u +%Y%m%d-%H%M%S-%N)"
[ ! -e "$BACKUP" ] || die "backup name $BACKUP already exists"
cp -p -- "$CONF" "$BACKUP" || die "cannot write the backup $BACKUP"
# The backup must be byte-identical to the file now AND hold exactly the text the plan was made from.
cmp -s -- "$CONF" "$BACKUP" && [ "$(cat -- "$BACKUP")" = "$CURRENT" ] \
  || die "the backup $BACKUP does not match $CONF as read (it changed, or the copy failed); nothing was modified"
say "  ok    backup: $BACKUP (verified identical)"
TMP="$(mktemp "$CONF.new.XXXXXX")" || die "cannot create a temporary file next to $CONF"
printf '%s\n' "$NEW" > "$TMP" && chown --reference="$BACKUP" "$TMP" && chmod --reference="$BACKUP" "$TMP" \
  || { rm -f -- "$TMP"; die "cannot prepare the new $CONF (unchanged; backup at $BACKUP)"; }
# Last check right before the atomic replace: the file must still be exactly what was read and backed up.
cmp -s -- "$CONF" "$BACKUP" || { rm -f -- "$TMP"; die "$CONF changed while this script was running; nothing was modified (backup of the earlier version: $BACKUP)"; }
mv -f -- "$TMP" "$CONF" || { rm -f -- "$TMP"; die "cannot write $CONF (unchanged; backup at $BACKUP)"; }
say "  ok    $CONF updated"
ROLLBACK="sudo cp -p $BACKUP $CONF && sudo systemctl reload docker"
systemctl reload docker || die "systemctl reload docker failed. Roll back with: $ROLLBACK"
active_ok 10 || die "docker info does not show runsc with [\"$FLAG\"] after the reload. Roll back with: $ROLLBACK"
say "  ok    docker info: runsc at $RUNSC with runtimeArgs [\"$FLAG\"]"
say ""
say "PASS: gVisor in-sandbox seccomp is enabled. Backup: $BACKUP"
say "Rollback if ever needed: $ROLLBACK"
