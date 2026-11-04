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
# Refuses (exit 1, message on stderr) on anything unexpected.
plan_change() {
  J_IN="$1" "$NODE_BIN" -e '
    const [runsc, flag] = process.argv.slice(1);
    const fail = (m) => { process.stderr.write(m); process.exit(1); };
    let c; try { c = JSON.parse(process.env.J_IN); } catch { fail("daemon.json is not valid JSON"); }
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

say "Enable gVisor in-sandbox seccomp: runtimes.runsc.runtimeArgs = [\"$FLAG\"] in $CONF"
if [ "$EXECUTE" = 1 ] && [ "$(id -u)" != 0 ]; then die "--execute must run as root (sudo)"; fi
[ -e "$CONF" ] || die "$CONF does not exist"
[ -L "$CONF" ] && die "$CONF is a symbolic link"
[ -f "$CONF" ] || die "$CONF is not a regular file"
if [ -z "$CHECK" ]; then
  [ "$(stat -c %u "$CONF")" = 0 ] || die "$CONF is not owned by root"
  [ $(( 0$(stat -c %a "$CONF") & 022 )) = 0 ] || die "$CONF is writable by group or others"
fi
CURRENT="$(cat -- "$CONF")" || die "cannot read $CONF"
NEW="$(plan_change "$CURRENT")"; RC=$?
if [ "$RC" = 3 ]; then say "  ok    already enabled: runsc is registered with exactly [\"$FLAG\"]; nothing to change"; exit 0; fi
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
cp -p -- "$CONF" "$BACKUP" || die "cannot write the backup $BACKUP"
say "  ok    backup: $BACKUP"
TMP="$(mktemp "$CONF.new.XXXXXX")" || die "cannot create a temporary file next to $CONF"
printf '%s\n' "$NEW" > "$TMP" && chown --reference="$CONF" "$TMP" && chmod --reference="$CONF" "$TMP" && mv -f -- "$TMP" "$CONF" \
  || { rm -f -- "$TMP"; die "cannot write $CONF (unchanged; backup at $BACKUP)"; }
say "  ok    $CONF updated"
ROLLBACK="sudo cp -p $BACKUP $CONF && sudo systemctl reload docker"
systemctl reload docker || die "systemctl reload docker failed. Roll back with: $ROLLBACK"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  GOT="$("$DOCKER" --host unix:///var/run/docker.sock info --format '{{json .Runtimes.runsc}}' 2>/dev/null)" || GOT=""
  if J_IN="$GOT" "$NODE_BIN" -e 'const r=JSON.parse(process.env.J_IN||"null");process.exit(r&&r.path===process.argv[1]&&JSON.stringify(r.runtimeArgs)===JSON.stringify([process.argv[2]])?0:1)' "$RUNSC" "$FLAG" 2>/dev/null; then
    say "  ok    docker info: runsc at $RUNSC with runtimeArgs [\"$FLAG\"]"
    say ""
    say "PASS: gVisor in-sandbox seccomp is enabled. Backup: $BACKUP"
    say "Rollback if ever needed: $ROLLBACK"
    exit 0
  fi
  sleep 1
done
die "docker info does not show runsc with [\"$FLAG\"] after the reload. Roll back with: $ROLLBACK"
