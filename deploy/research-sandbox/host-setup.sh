#!/usr/bin/env bash
# Research sandbox host setup and verification (V2). Run from the repository
# root on the APPROVED host only:
#
#   sudo bash deploy/research-sandbox/host-setup.sh                      # dry run (default): prints the plan
#   sudo bash deploy/research-sandbox/host-setup.sh --execute            # does it (base image already present)
#   sudo bash deploy/research-sandbox/host-setup.sh --execute --allow-base-pull   # also downloads the base image once
#   optional: --expect-base-digest=sha256:<64 hex>  refuse unless the base image has exactly this digest
#
# Dry run: local read-only checks only. It makes NO Docker call and writes
# nothing.
#
# --execute, in order, stopping at the first failure:
#   1. read-only checks: root, repository files, Node 22, Docker rootful,
#      seccomp builtin, runsc registered by path with no flags, runc default,
#      no leftover sandbox or setup containers;
#   2. the pinned base image (pulled only with --allow-base-pull) and its
#      digest, entrypoint, environment and platform manifest digest;
#   3. the canary image, built offline (--pull=false, --network none, no
#      attestations, FROM the recorded base digest), recorded by image ID,
#      with its own manifest digest (Option B);
#   4. gVisor's /proc/version from ONE runsc container (no network, read-only,
#      no capabilities, uid 10001), which must differ from the host's;
#   5. the runsc binary and every gVisor sidecar file, by SHA-256;
#   6. host folders for one run, an empty Docker client config folder, the
#      runner configuration (root-only), then the repository's preflight
#      runner. Expected result while M1/M3 stand: "refused only by M1/M3".
# Temporary containers (research-setup-*) are never published, never get a
# network, mounts or privileges, and are always removed. Nothing touches
# daemon.json, AppArmor, UFW, SSH or packages. Images, pins and the
# configuration are kept for review; removing them is a separate step.
set -u
set -o pipefail
umask 022

BASE_REF="docker.io/library/node:22.22.0-bookworm-slim"   # must equal the sandbox spec (checked by a test)
DOCKER=/usr/bin/docker
RUNS_ROOT=/srv/research-runs
CANARY_DIR=/srv/research-canary
CANARY_FILE="$CANARY_DIR/host-canary.txt"
ENGINE_CONFIG_DIR=/root/research-docker-config
CONF_DIR=/etc/research-sandbox
CONF="$CONF_DIR/preflight.json"
STATE_ROOT=/var/lib/research-sandbox-setup
SANDBOX_UID=10001
ENV_ALLOWED="PATH NODE_VERSION YARN_VERSION"

EXECUTE=0; ALLOW_PULL=0; EXPECT_DIGEST=""
for arg in "$@"; do
  case "$arg" in
    --execute) EXECUTE=1 ;;
    --allow-base-pull) ALLOW_PULL=1 ;;
    --expect-base-digest=*) EXPECT_DIGEST="${arg#--expect-base-digest=}"
      [[ "$EXPECT_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "Usage error: --expect-base-digest must be sha256:<64 lowercase hex>"; exit 2; } ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Usage error: unknown argument '$arg'. See: bash $0 --help"; exit 2 ;;
  esac
done
if [ "$ALLOW_PULL" = 1 ] && [ "$EXECUTE" = 0 ]; then echo "Usage error: --allow-base-pull needs --execute"; exit 2; fi

STOPPED=0
say()  { echo "$*"; [ -n "${LOG:-}" ] && echo "$*" >> "$LOG"; return 0; }
step() { say ""; say "== $*"; }
ok()   { say "  ok    $*"; }
die()  { say "  STOP  $*"; STOPPED=1; exit 1; }
plan() { say "  plan  $*"; }

# ---------------------------------------------------------------- local checks (both modes; read-only, no Docker)
step "Local checks (read-only)"
for f in deploy/research-sandbox/Dockerfile.canary deploy/research-sandbox/package.json \
         dist/research-sandbox/preflight-main.js dist/research-sandbox/canary-probe.js dist/research-sandbox/canary.js; do
  [ -f "$f" ] && [ ! -L "$f" ] || die "missing $f (run from the repository root after building with ./node_modules/.bin/tsc)"
done
ok "repository files present"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "node is not installed (Node 22 is required)"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
[ "$NODE_MAJOR" = 22 ] || die "Node 22 is required (found '${NODE_MAJOR:-none}' at $NODE_BIN)"
ok "Node 22 at $NODE_BIN"

if [ "$EXECUTE" = 0 ]; then
  step "DRY RUN: nothing below has been done (no Docker call, no file written)"
  plan "check: run as root; Docker CLI at $DOCKER; rootful; seccomp profile builtin; runsc registered by path with no flags; default runtime runc"
  plan "check: no existing containers named research-sandbox-* or research-setup-*"
  plan "base image $BASE_REF: use if present; download it ONLY with --allow-base-pull"
  plan "record: base digest, entrypoint, environment (only $ENV_ALLOWED), platform manifest digest (one container CREATED, never started, removed)"
  plan "build canary: $DOCKER build --pull=false --network none --provenance=false --sbom=false --build-arg NODE_BASE_DIGEST=<digest> --iidfile <file> -f deploy/research-sandbox/Dockerfile.canary <temporary context>"
  plan "record: canary image ID and its own manifest digest (one container CREATED, never started, removed)"
  plan "record: gVisor /proc/version from ONE container: --rm --pull never --runtime runsc --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --user $SANDBOX_UID:$SANDBOX_UID"
  plan "record: Docker server version and data root; runsc path and SHA-256; SHA-256 of every file in its gvisor-bin folder"
  plan "create: $RUNS_ROOT/setup-<time>/in (root, 755), .../out (uid $SANDBOX_UID, 700, empty), $CANARY_FILE (root, 644), $ENGINE_CONFIG_DIR (root, 700, empty)"
  plan "write: $CONF (root, 600); logs and pins under $STATE_ROOT/setup-<time>/"
  plan "run: node dist/research-sandbox/preflight-main.js --config $CONF --confirm-docker-access --output json"
  plan "expected while M1/M3 stand: REFUSED, every check passed, refused only by the M1/M3 blockers"
  say ""
  say "Dry run complete. Re-run with --execute (add --allow-base-pull if the base image is not yet on the host) after approval."
  exit 0
fi

# ---------------------------------------------------------------- execute mode
[ "$(id -u)" = 0 ] || die "--execute must run as root (sudo)"
# Root will execute this node binary: it must be root-owned and not writable by group or others (also through a symlink).
NODE_REAL="$(readlink -f "$NODE_BIN")" || die "cannot resolve $NODE_BIN"
NODE_STAT="$(stat -c '%u %a' "$NODE_REAL")" || die "cannot inspect $NODE_REAL"
[ "${NODE_STAT%% *}" = 0 ] && (( (8#${NODE_STAT#* } & 8#0022) == 0 )) || die "$NODE_REAL must be root-owned and not writable by group or others (found ${NODE_STAT})"
# Our state folder: an existing one is verified, never re-permissioned.
if [ -e "$STATE_ROOT" ] || [ -L "$STATE_ROOT" ]; then
  [ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] || die "$STATE_ROOT exists but is not a real directory"
  SR="$(stat -c '%u %a' "$STATE_ROOT")" || die "cannot inspect $STATE_ROOT"
  [ "${SR%% *}" = 0 ] && (( (8#${SR#* } & 8#0077) == 0 )) || die "$STATE_ROOT must be root-owned and private (found $SR)"
else
  mkdir -m 700 "$STATE_ROOT" || die "cannot create $STATE_ROOT"
fi
RUN_ID="setup-$(date -u +%Y%m%d-%H%M%S-%N)"
OUT="$STATE_ROOT/$RUN_ID"
mkdir -m 700 "$OUT" || die "cannot create $OUT (does a run with this time already exist?)"
LOG="$OUT/setup.log"; : > "$LOG"
say "Run $RUN_ID; log and pins in $OUT"
TMP_CONTAINERS=()
BUILD_CTX=""
cleanup() {
  local c
  for c in "${TMP_CONTAINERS[@]}"; do
    if [ -n "$("$DOCKER" ps -aq --filter "name=^/${c}\$" 2>/dev/null)" ]; then
      "$DOCKER" rm -f "$c" >/dev/null 2>&1 && say "  cleanup: removed $c" || say "  cleanup FAILED: remove manually: sudo docker rm -f $c"
    fi
  done
  case "$BUILD_CTX" in "$OUT"/build.*) [ -d "$BUILD_CTX" ] && rm -rf -- "$BUILD_CTX" ;; esac
  [ "$STOPPED" = 1 ] && say "" && say "Setup stopped. Nothing was changed outside $OUT and the folders listed above; see $LOG."
  return 0
}
trap cleanup EXIT
trap 'say "Interrupted."; STOPPED=1; exit 130' INT TERM
j() { "$NODE_BIN" -e "$1" "${@:2}"; }   # small JSON helper: node -e '<code>' args...
# Same, but the (possibly sensitive) JSON input travels in the environment, not on the command line:
# command lines are visible to every local user (ps), a process environment only to root.
jin() { J_IN="$1" "$NODE_BIN" -e "$2" "${@:3}"; }

step "1. Docker checks (read-only)"
[ -x "$DOCKER" ] && [ ! -L "$DOCKER" ] || die "Docker CLI not found at $DOCKER"
INFO="$("$DOCKER" info --format '{{json .}}' 2>/dev/null)" || die "docker info failed"
SERVER_VERSION="$(jin "$INFO" 'const i=JSON.parse(process.env.J_IN);process.stdout.write(String(i.ServerVersion||""))')" || die "cannot parse docker info"
DATA_ROOT="$(jin "$INFO" 'const i=JSON.parse(process.env.J_IN);process.stdout.write(String(i.DockerRootDir||""))')" || die "cannot parse docker info"
[ -n "$SERVER_VERSION" ] && [ -n "$DATA_ROOT" ] || die "docker info did not report ServerVersion and DockerRootDir"
CHECK="$(jin "$INFO" '
  const i=JSON.parse(process.env.J_IN); const p=[];
  const opts=Array.isArray(i.SecurityOptions)?i.SecurityOptions:[];
  const sec=opts.filter(o=>typeof o==="string"&&/^name=seccomp(,|$)/.test(o));
  if(sec.length!==1||sec[0]!=="name=seccomp,profile=builtin") p.push("seccomp profile is not exactly builtin: "+JSON.stringify(sec));
  if(opts.includes("name=rootless")) p.push("Docker is rootless");
  if(i.DefaultRuntime!=="runc") p.push("default runtime is not runc");
  const r=i.Runtimes&&i.Runtimes.runsc;
  if(!r||typeof r!=="object") p.push("runsc is not registered");
  else { const extra=Object.keys(r).filter(k=>!["path","status"].includes(k)); if(extra.length) p.push("runsc registration has "+extra.join(", "));
         if(typeof r.path!=="string"||!/^\/usr(\/local)?\/s?bin\/[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(r.path)) p.push("runsc path is not an absolute system binary path"); }
  process.stdout.write(p.join("; "));')" || die "cannot evaluate docker info"
[ -z "$CHECK" ] || die "$CHECK"
RUNSC_PATH="$(jin "$INFO" 'process.stdout.write(JSON.parse(process.env.J_IN).Runtimes.runsc.path)')" || die "cannot read the runsc path"
ok "Docker $SERVER_VERSION, data root $DATA_ROOT, seccomp builtin, rootful, runsc at $RUNSC_PATH with no flags"
LEFT="$("$DOCKER" ps -aq --filter name=^/research-sandbox- 2>/dev/null; "$DOCKER" ps -aq --filter name=^/research-setup- 2>/dev/null)" || die "docker ps failed"
[ -z "$LEFT" ] || die "leftover research-sandbox-* or research-setup-* containers exist; remove them first"
ok "no leftover sandbox or setup containers"

step "2. Base image"
if ! "$DOCKER" image inspect "$BASE_REF" >/dev/null 2>&1; then
  [ "$ALLOW_PULL" = 1 ] || die "base image $BASE_REF is not on this host; re-run with --allow-base-pull to download it (approved step)"
  say "  pulling $BASE_REF (one download)"
  "$DOCKER" pull "$BASE_REF" >> "$LOG" 2>&1 || die "pull failed (see $LOG)"
fi
BASE_JSON="$("$DOCKER" image inspect "$BASE_REF" 2>/dev/null)" || die "cannot inspect $BASE_REF"
BASE_FIELDS="$(jin "$BASE_JSON" '
  const [img]=JSON.parse(process.env.J_IN); const allowed=process.argv[1].split(" ");
  const d=[...new Set((img.RepoDigests||[]).filter(r=>/^(docker\.io\/library\/)?node@sha256:[0-9a-f]{64}$/.test(r)).map(r=>r.slice(r.indexOf("@")+1)))];
  if(d.length!==1){process.stdout.write("ERR:the base image has "+d.length+" node repository digests");process.exit(0);}
  const env=img.Config&&img.Config.Env||[]; const bad=env.filter(e=>!allowed.includes(String(e).split("=")[0]));
  if(bad.length){process.stdout.write("ERR:the base image environment has unexpected names: "+bad.map(e=>String(e).split("=")[0]).join(","));process.exit(0);}
  const ep=img.Config&&img.Config.Entrypoint;
  if(!Array.isArray(ep)||!ep.length){process.stdout.write("ERR:the base image has no entrypoint");process.exit(0);}
  process.stdout.write(JSON.stringify({digest:d[0],entrypoint:ep,env}));' "$ENV_ALLOWED")" || die "cannot evaluate the base image"
case "$BASE_FIELDS" in ERR:*) die "${BASE_FIELDS#ERR:}";; esac
BASE_DIGEST="$(j 'process.stdout.write(JSON.parse(process.argv[1]).digest)' "$BASE_FIELDS")" || die "cannot read the base digest"
[[ "$BASE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || die "malformed base digest"
[ -z "$EXPECT_DIGEST" ] || [ "$BASE_DIGEST" = "$EXPECT_DIGEST" ] || die "the base image digest $BASE_DIGEST is not the expected $EXPECT_DIGEST"
ok "base digest $BASE_DIGEST"

# Platform manifest digest as Docker reports it for a container (created, never started, removed).
manifest_of() {  # manifest_of <image-ref> <container-name>  -> prints digest, "none", or ERR:...
  local ref="$1" name="$2" json
  TMP_CONTAINERS+=("$name")
  "$DOCKER" create --pull never --name "$name" --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --user "$SANDBOX_UID:$SANDBOX_UID" "$ref" true >> "$LOG" 2>&1 || { echo "ERR:cannot create $name"; return 0; }
  json="$("$DOCKER" inspect "$name" 2>/dev/null)" || { echo "ERR:cannot inspect $name"; return 0; }
  "$DOCKER" rm "$name" >> "$LOG" 2>&1 || { echo "ERR:cannot remove $name"; return 0; }
  jin "$json" 'const [c]=JSON.parse(process.env.J_IN);
     if(!c||!c.State||c.State.Status!=="created"){process.stdout.write("ERR:container was started or has no state");process.exit(0);}
     const m=c.ImageManifestDescriptor;
     if(m===undefined){process.stdout.write("none "+c.Image);process.exit(0);}
     if(!m||typeof m.digest!=="string"||!/^sha256:[0-9a-f]{64}$/.test(m.digest)){process.stdout.write("ERR:malformed ImageManifestDescriptor");process.exit(0);}
     process.stdout.write(m.digest+" "+c.Image);' || echo "ERR:cannot evaluate $name"
}
valid_manifest() { [ "$1" = none ] || [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]; }
BASE_M="$(manifest_of "docker.io/library/node@$BASE_DIGEST" "research-setup-$RUN_ID-base")"
case "$BASE_M" in ERR:*) die "${BASE_M#ERR:}";; esac
BASE_MANIFEST="${BASE_M%% *}"
valid_manifest "$BASE_MANIFEST" || die "malformed base manifest result: $BASE_M"
ok "base platform manifest digest: $BASE_MANIFEST"

step "3. Canary image (offline build, recorded by image ID)"
BUILD_CTX="$(mktemp -d "$OUT/build.XXXXXX")" || die "cannot create a build context"
cp -- deploy/research-sandbox/package.json dist/research-sandbox/canary-probe.js dist/research-sandbox/canary.js "$BUILD_CTX/" || die "cannot prepare the build context"
chmod 644 "$BUILD_CTX"/* && (cd "$BUILD_CTX" && sha256sum package.json canary-probe.js canary.js) > "$OUT/canary-files.sha256" || die "cannot hash the build context"
"$DOCKER" build --pull=false --network none --provenance=false --sbom=false --build-arg "NODE_BASE_DIGEST=$BASE_DIGEST" \
  --iidfile "$OUT/canary.iid" -f deploy/research-sandbox/Dockerfile.canary "$BUILD_CTX" >> "$LOG" 2>&1 || die "canary build failed (see $LOG)"
IMAGE_ID="$(cat "$OUT/canary.iid" 2>/dev/null)"
[[ "$IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || die "the build did not produce a full image ID"
[ "$IMAGE_ID" != "$BASE_DIGEST" ] || die "the canary image ID equals the base digest"
CANARY_CFG="$("$DOCKER" image inspect --format '{{json .Config.Entrypoint}}|{{json .Config.Env}}' "$IMAGE_ID" 2>/dev/null)" || die "cannot inspect the canary image"
SAME="$(j 'const b=JSON.parse(process.argv[1]); const [ep,env]=process.argv[2].split("|").map(x=>JSON.parse(x));
  process.stdout.write(JSON.stringify(ep)===JSON.stringify(b.entrypoint)&&JSON.stringify(env)===JSON.stringify(b.env)?"yes":"no")' "$BASE_FIELDS" "$CANARY_CFG")" || die "cannot compare the canary image with the base image"
[ "$SAME" = yes ] || die "the canary image's entrypoint or environment differs from the base image's"
CANARY_M="$(manifest_of "$IMAGE_ID" "research-setup-$RUN_ID-canary")"
case "$CANARY_M" in ERR:*) die "${CANARY_M#ERR:}";; esac
CANARY_MANIFEST="${CANARY_M%% *}"; CANARY_IMAGE_SEEN="${CANARY_M#* }"
valid_manifest "$CANARY_MANIFEST" || die "malformed canary manifest result: $CANARY_M"
[ "$CANARY_IMAGE_SEEN" = "$IMAGE_ID" ] || die "a container created from $IMAGE_ID reports image $CANARY_IMAGE_SEEN"
if [ "$BASE_MANIFEST" = none ] && [ "$CANARY_MANIFEST" = none ]; then ok "classic image store: no manifest descriptors (both pins null)"
elif [ "$BASE_MANIFEST" != none ] && [ "$CANARY_MANIFEST" != none ] && [ "$BASE_MANIFEST" != "$CANARY_MANIFEST" ]; then ok "containerd image store: canary manifest digest $CANARY_MANIFEST"
else die "manifest descriptors are inconsistent (base: $BASE_MANIFEST, canary: $CANARY_MANIFEST)"; fi
ok "canary image ID $IMAGE_ID (entrypoint and environment equal the base image's)"

step "4. gVisor reference (/proc/version from one runsc container)"
GNAME="research-setup-$RUN_ID-gvisor"; TMP_CONTAINERS+=("$GNAME")
GVISOR_RAW="$(timeout --kill-after=10 120 "$DOCKER" run --rm --pull never --name "$GNAME" --runtime runsc --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user "$SANDBOX_UID:$SANDBOX_UID" --memory 256m --memory-swap 256m --pids-limit 64 \
  "$IMAGE_ID" cat /proc/version 2>>"$LOG")" || die "the runsc container failed (see $LOG)"
# Trimmed exactly as the canary probe trims it, so the recorded reference matches what the preflight compares.
GVISOR="$(j 'process.stdout.write(process.argv[1].trim())' "$GVISOR_RAW")" || die "cannot normalise the gVisor /proc/version"
HOSTV="$(j 'process.stdout.write(require("fs").readFileSync("/proc/version","utf8").trim())')" || die "cannot read the host /proc/version"
[ -n "$GVISOR" ] && [ "${#GVISOR}" -le 512 ] && [ "$(printf '%s' "$GVISOR" | wc -l)" = 0 ] || die "unexpected /proc/version from runsc"
[ "$GVISOR" != "$HOSTV" ] || die "runsc shows the HOST kernel: gVisor is not positively identified"
ok "gVisor reports: $GVISOR"

step "5. runsc binary and gVisor sidecar files"
[ -f "$RUNSC_PATH" ] && [ ! -L "$RUNSC_PATH" ] || die "$RUNSC_PATH is not a regular file"
RUNSC_SHA="$(sha256sum "$RUNSC_PATH" | cut -d' ' -f1)" && [[ "$RUNSC_SHA" =~ ^[0-9a-f]{64}$ ]] || die "cannot hash $RUNSC_PATH"
SIDECAR_DIR="$(dirname "$RUNSC_PATH")/gvisor-bin"
SIDECARS="[]"
if [ -e "$SIDECAR_DIR" ] || [ -L "$SIDECAR_DIR" ]; then
  [ -d "$SIDECAR_DIR" ] && [ ! -L "$SIDECAR_DIR" ] || die "$SIDECAR_DIR is not a real directory"
  [ -z "$(find "$SIDECAR_DIR" -mindepth 1 \( -type l -o ! \( -type f -o -type d \) \))" ] || die "$SIDECAR_DIR contains symlinks or special files"
  SIDECARS="$(find "$SIDECAR_DIR" -type f -print0 | sort -z | xargs -0 -r sha256sum | j '
    const lines=require("fs").readFileSync(0,"utf8").trim().split("\n").filter(Boolean);
    process.stdout.write(JSON.stringify(lines.map(l=>({path:l.slice(66),sha256:l.slice(0,64)}))));')" || die "cannot hash $SIDECAR_DIR"
fi
# Cross-check with the package manager: every executable file the runsc package installs must be recorded.
if PKG_FILES="$(dpkg -L runsc 2>/dev/null)"; then
  EXTRA="$(printf '%s\n' "$PKG_FILES" | while read -r f; do
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    case "$f" in "$RUNSC_PATH"|"$SIDECAR_DIR"/*|/usr/share/*) continue ;; esac
    echo "$f"; done)"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in /usr/bin/*|/usr/sbin/*|/usr/local/bin/*|/usr/local/sbin/*)
      [ "$(dirname "$f")" = /usr/bin ] || [ "$(dirname "$f")" = /usr/sbin ] || [ "$(dirname "$f")" = /usr/local/bin ] || [ "$(dirname "$f")" = /usr/local/sbin ] \
        || die "runsc package file $f is nested inside a system binary folder; it can't be recorded"
      FSHA="$(sha256sum "$f" | cut -d' ' -f1)" && [[ "$FSHA" =~ ^[0-9a-f]{64}$ ]] || die "cannot hash $f"
      SIDECARS="$(j 'const a=JSON.parse(process.argv[1]); const [p,h]=[process.argv[2],process.argv[3]]; a.push({path:p,sha256:h}); process.stdout.write(JSON.stringify(a))' \
        "$SIDECARS" "$f" "$FSHA")" || die "cannot record $f" ;;
    *) die "runsc package file $f is outside the recordable folders (review it before continuing)" ;;
    esac
  done <<< "$EXTRA"
  ok "dpkg cross-check: every runsc package executable is recorded"
else
  say "  note  runsc is not managed by dpkg; only $SIDECAR_DIR was inventoried"
fi
ok "runsc $RUNSC_PATH sha256 $RUNSC_SHA; sidecars: $(j 'process.stdout.write(String(JSON.parse(process.argv[1]).length))' "$SIDECARS")"

step "6. Host folders, runner configuration and the preflight"
# Existing folders are verified, never re-permissioned; missing ones are created root-owned 755.
for d in /srv "$RUNS_ROOT" "$CANARY_DIR" "$CONF_DIR"; do
  if [ -e "$d" ] || [ -L "$d" ]; then
    [ -d "$d" ] && [ ! -L "$d" ] || die "$d exists but is not a real directory"
    M="$(stat -c '%u %a' "$d")"; U="${M%% *}"; A="${M#* }"
    [ "$U" = 0 ] && (( (8#$A & 8#0022) == 0 )) || die "$d must be root-owned and not writable by group or others (found uid $U, mode $A)"
  else
    mkdir -m 755 "$d" && chown root:root "$d" || die "cannot create $d"
  fi
done
if [ -e "$ENGINE_CONFIG_DIR" ] || [ -L "$ENGINE_CONFIG_DIR" ]; then
  [ -d "$ENGINE_CONFIG_DIR" ] && [ ! -L "$ENGINE_CONFIG_DIR" ] && [ -z "$(ls -A "$ENGINE_CONFIG_DIR")" ] || die "$ENGINE_CONFIG_DIR exists and is not an empty real directory"
  EC="$(stat -c '%u %a' "$ENGINE_CONFIG_DIR")" || die "cannot inspect $ENGINE_CONFIG_DIR"
  [ "${EC%% *}" = 0 ] && (( (8#${EC#* } & 8#0077) == 0 )) || die "$ENGINE_CONFIG_DIR must be root-owned and private (found $EC); it is not changed"
else mkdir -m 700 "$ENGINE_CONFIG_DIR" && chown root:root "$ENGINE_CONFIG_DIR" || die "cannot create $ENGINE_CONFIG_DIR"; fi
RUN_DIR="$RUNS_ROOT/$RUN_ID"
mkdir -m 755 "$RUN_DIR" "$RUN_DIR/in" && mkdir -m 700 "$RUN_DIR/out" && chown "$SANDBOX_UID:$SANDBOX_UID" "$RUN_DIR/out" || die "cannot create $RUN_DIR"
[ -L "$CANARY_FILE" ] && die "$CANARY_FILE is a symbolic link"
[ -e "$CANARY_FILE" ] || { echo "research sandbox host canary (must never be visible inside a container)" > "$CANARY_FILE" && chmod 644 "$CANARY_FILE"; } || die "cannot create $CANARY_FILE"
ok "folders ready: $RUN_DIR/{in,out}, $CANARY_FILE, $ENGINE_CONFIG_DIR"
CONF_TMP="$(mktemp "$CONF_DIR/.preflight.XXXXXX")" || die "cannot create a temporary file in $CONF_DIR"
( umask 077; j '
  const [runId,base,dataRoot,server,runsc,runscSha,sidecars,imageId,canaryManifest,baseManifest,gvisor,canaryFile,engineDir]=process.argv.slice(1);
  const b=JSON.parse(base);
  const cfg={version:1,engineBinary:"/usr/bin/docker",engineConfigDir:engineDir,runId,hostCanaryPath:canaryFile,operatorUid:0,outputOwnerUid:10001,
    pins:{imageDigest:b.digest,imageEntrypoint:b.entrypoint,imageEnv:b.env,imageManifestDigest:baseManifest==="none"?null:baseManifest,
          imageId,canaryManifestDigest:canaryManifest==="none"?null:canaryManifest,gvisorProcVersion:gvisor,dockerDataRoot:dataRoot,
          runscBinary:{path:runsc,sha256:runscSha,args:[],sidecars:JSON.parse(sidecars)},dockerServerVersion:server}};
  process.stdout.write(JSON.stringify(cfg,null,2)+"\n");' \
  "$RUN_ID" "$BASE_FIELDS" "$DATA_ROOT" "$SERVER_VERSION" "$RUNSC_PATH" "$RUNSC_SHA" "$SIDECARS" "$IMAGE_ID" "$CANARY_MANIFEST" "$BASE_MANIFEST" "$GVISOR" "$CANARY_FILE" "$ENGINE_CONFIG_DIR" > "$CONF_TMP" ) \
  && chown root:root "$CONF_TMP" && chmod 600 "$CONF_TMP" && mv -f "$CONF_TMP" "$CONF" && cp "$CONF" "$OUT/preflight-config.json" || { rm -f -- "$CONF_TMP"; die "cannot write $CONF"; }
ok "runner configuration written to $CONF (root, 600); a copy is in $OUT"

"$NODE_BIN" dist/research-sandbox/preflight-main.js --config "$CONF" --confirm-docker-access --output json > "$OUT/preflight-report.json" 2>> "$LOG"
RC=$?
VERDICT="$(j 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  if(r.blockedOnlyByMeetsSpecBlockers===true&&r.rating==="refused"&&r.allowsUntrustedInput===false&&r.cleanup&&r.cleanup.verifiedRemoved===true)process.stdout.write("EXPECTED");
  else process.stdout.write("PROBLEMS: "+(r.violations||[]).join(" | ").slice(0,1500));}catch(e){process.stdout.write("NO-REPORT");}' "$OUT/preflight-report.json")" || die "cannot evaluate the preflight report"
say ""
case "$VERDICT" in
  EXPECTED) [ "$RC" = 1 ] || die "unexpected runner exit code $RC"
    say "RESULT: every preflight check passed on this host; refused only by the M1/M3 blockers (as expected)."
    say "Send me: $OUT/preflight-report.json, $OUT/preflight-config.json, $OUT/canary-files.sha256 and $LOG" ;;
  *) die "preflight did not reach the expected result (exit $RC): $VERDICT. Send me $OUT/preflight-report.json and $LOG" ;;
esac
