#!/usr/bin/env bash
# E1b: collect the evidence for the research image in one pass, AFTER
#   sudo bash deploy/research-sandbox/host-setup.sh --execute ...
# has built the research image and passed its preflight.
#
#   sudo bash deploy/research-sandbox/e1b-verify.sh --execute
#
# Stages (each stops the run on failure; later stages never run after a STOP):
#   1. the newest host-setup run whose configuration equals the current one
#      must have a preflight report refused ONLY by M1/M3, under runsc, with
#      gVisor host-process evidence and verified cleanup;
#   2. read-only trust evidence (no kernel or OS versions recorded), checked
#      for internal consistency and agreement with its exit code;
#   3. negative controls: every deliberately wrong pin must be refused;
#   4. executor dry run with the committed synthetic sample job: the sample
#      files are copied into the run's (empty) input folder, the executor runs
#      a fresh preflight and MUST be refused by the M1/M3 gate, and no research
#      container may exist afterwards;
#   5. the four JSON evidence files, their SHA-256 values, and the same files
#      as numbered pieces with per-piece checksums (for transfer).
# Changes on the host: one new evidence folder under the setup state root,
# the sample files in the run's input folder, and canary containers that the
# preflights create and remove. It never changes Docker configuration and
# never runs research: the gate refuses before any research container exists.
# Exit: 0 PASS, 4 REVIEW (trust findings to review; expected), 1 STOP, 2 usage.

set -u
set -o pipefail

CONF=/etc/research-sandbox/preflight.json
STATE_ROOT=/var/lib/research-sandbox-setup
RUNS_ROOT=/srv/research-runs
DOCKER=/usr/bin/docker
SAMPLE=deploy/research-sandbox/e1b-sample

[ "$#" = 1 ] && [ "$1" = --execute ] || { echo "Usage: sudo bash deploy/research-sandbox/e1b-verify.sh --execute"; exit 2; }
[ "$(id -u)" = 0 ] || { echo "STOP: run as root (sudo)"; exit 1; }
NODE="$(command -v node)" || { echo "STOP: node is required"; exit 1; }
for f in dist/research-sandbox/trust-evidence-main.js dist/research-sandbox/negative-controls-main.js dist/research-sandbox/executor-main.js \
         "$SAMPLE/fict-us-trend.json" "$SAMPLE/run-us-ma.json" "$SAMPLE/job.json"; do
  [ -f "$f" ] && [ ! -L "$f" ] || { echo "STOP: missing $f (run from the repository root after building)"; exit 1; }
done
EV="$STATE_ROOT/e1b-$(date -u +%Y%m%d-%H%M%S-%N)"
mkdir -m 700 "$EV" || { echo "STOP: cannot create $EV"; exit 1; }
done_() { echo; echo "$1"; echo "Evidence: $EV"; exit "$2"; }
stop() { done_ "STOP: $*" 1; }
js() { "$NODE" -e "$@"; }

echo "== 1/5 preflight report of the current host-setup run"
SETUP=""
for d in $(ls -1d "$STATE_ROOT"/setup-* 2>/dev/null | LC_ALL=C sort -r); do
  if [ -f "$d/preflight-report.json" ] && [ -f "$d/preflight-config.json" ] && cmp -s "$d/preflight-config.json" "$CONF"; then SETUP="$d"; break; fi
done
[ -n "$SETUP" ] || stop "no host-setup run with the current configuration and a preflight report (run host-setup.sh --execute first)"
cp -- "$SETUP/preflight-report.json" "$EV/preflight-report.json" || stop "cannot copy the preflight report"
js 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")),h=r.hostProcessEvidence;process.exit(r.runner==="research-sandbox-preflight"&&r.rating==="refused"&&r.allowsUntrustedInput===false&&r.blockedOnlyByMeetsSpecBlockers===true&&r.runtime==="runsc"&&r.cleanup&&r.cleanup.verifiedRemoved===true&&Array.isArray(r.steps)&&r.steps.includes("host-process-evidence")&&h&&h.polls>=10&&h.sandboxProcesses>=1&&h.canaryOnHost===0&&h.replacedExecutables===0&&h.overflow===false?0:1)' "$EV/preflight-report.json" \
  || stop "the preflight report of $SETUP does not show a pass refused only by M1/M3 with gVisor host-process evidence"
RUNID="$(js 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(c.runId))process.exit(1);process.stdout.write(c.runId)' "$CONF")" || stop "cannot read the run id from $CONF"
echo "   ok  $SETUP (run $RUNID)"

echo "== 2/5 read-only trust evidence"
"$NODE" dist/research-sandbox/trust-evidence-main.js --config "$CONF" --confirm-read-only-host-queries > "$EV/trust-evidence.json" 2> "$EV/trust-evidence.log"; TRC=$?
case "$TRC" in 0|1|4) ;; *) stop "trust evidence collection failed (exit $TRC; trust-evidence.log)";; esac
SUM="$(js 'const fs=require("fs"),c=require("crypto");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")),rc=Number(process.argv[2]),p=[];const canon=x=>Array.isArray(x)?x.map(canon):x&&typeof x==="object"?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon(x[k])])):x;const {digest,...body}=r;if(r.kind!=="research-sandbox-trust-evidence")p.push("kind");if(digest!=="sha256:"+c.createHash("sha256").update(JSON.stringify(canon(body))).digest("hex"))p.push("digest");const F=Array.isArray(r.findings)?r.findings:[];if(!Array.isArray(r.findings))p.push("findings");if(!F.every(f=>f&&(f.severity==="blocking"||f.severity==="review")&&["origin","signature","integrity","configuration","daemon"].includes(f.kind)&&typeof f.message==="string"))p.push("finding shape");const b=F.filter(f=>f&&f.severity==="blocking").length,v=F.filter(f=>f&&f.severity==="review").length;if(r.blocking!==b)p.push("blocking count");if(r.review!==v)p.push("review count");const verdict=b>0?"blocking":F.length>0?"needs-review":"clean";if(r.verdict!==verdict)p.push("verdict");const want={clean:0,blocking:1,"needs-review":4}[verdict];if(rc!==want)p.push(`exit code ${rc}, expected ${want}`);const di=(r.evidence&&r.evidence.dockerInfo)||{};if("KernelVersion" in di||"OperatingSystem" in di)p.push("host kernel/OS versions present");if(p.length){console.error("inconsistent: "+p.join(", "));process.exit(1)}console.log(`${verdict}: ${b} blocking, ${v} to review`);for(const f of F)console.log(`   [${f.severity}/${f.kind}] ${f.message.slice(0,220)}`);' "$EV/trust-evidence.json" "$TRC" 2>&1)" \
  || stop "trust-evidence.json is unreadable or inconsistent: $SUM"
echo "   $SUM"
[ "$TRC" != 1 ] || stop "trust evidence has blocking findings (above)"

echo "== 3/5 negative controls (canary only; one container at a time)"
"$NODE" dist/research-sandbox/negative-controls-main.js --config "$CONF" --confirm-docker-access --output json > "$EV/negative-controls.json" 2> "$EV/negative-controls.log"; NRC=$?
js 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const o of r.outcomes)console.log(`   ${o.passed?"ok  ":"FAIL"} ${o.name}: ${o.detail}`);process.exit(r.allPassed===true&&r.outcomes.length===r.expected?0:1)' "$EV/negative-controls.json" 2>/dev/null; JRC=$?
[ "$NRC" = 0 ] && [ "$JRC" = 0 ] || stop "negative controls did not all behave as expected (exit $NRC). Check: $DOCKER ps -a --filter name=research-sandbox-"

echo "== 4/5 executor dry run (synthetic sample; must be refused by the M1/M3 gate)"
IN="$RUNS_ROOT/$RUNID/in"
[ -d "$IN" ] && [ ! -L "$IN" ] || stop "the run input folder $IN does not exist"
[ -z "$(ls -A "$IN")" ] || stop "the run input folder $IN is not empty (nothing was changed; use a fresh host-setup run)"
cp -- "$SAMPLE/fict-us-trend.json" "$SAMPLE/run-us-ma.json" "$IN/" && chown 0:0 "$IN/fict-us-trend.json" "$IN/run-us-ma.json" && chmod 644 "$IN/fict-us-trend.json" "$IN/run-us-ma.json" \
  || stop "cannot stage the sample files into $IN"
cp -- "$SAMPLE/job.json" "$EV/job.json" && chmod 600 "$EV/job.json" || stop "cannot copy the sample job"
"$NODE" dist/research-sandbox/executor-main.js --config "$CONF" --job "$EV/job.json" --confirm-sandboxed-research > "$EV/executor-dryrun.json" 2> "$EV/executor-dryrun.log"; ERC=$?
js 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const ok=r.runner==="research-sandbox-executor"&&r.status==="refused"&&r.report===null&&r.violations[0]==="gate: untrusted input is not allowed by this preflight result"&&r.audit&&r.audit.containerId===null&&r.audit.researchExitCode===null&&!r.steps.includes("create")&&r.steps.includes("preflight")&&!r.steps.includes("gate-passed");process.exit(ok?0:1)' "$EV/executor-dryrun.json" 2>/dev/null; DRC=$?
[ "$ERC" = 1 ] && [ "$DRC" = 0 ] || stop "the executor dry run was not refused by the gate as expected (exit $ERC; executor-dryrun.json/.log)"
LEFT="$("$DOCKER" --host unix:///var/run/docker.sock ps -aq --filter "name=^/research-sandbox-$RUNID-run\$" 2>/dev/null)"; PRC=$?
[ "$PRC" = 0 ] && [ -z "$LEFT" ] || stop "a research container exists or docker ps failed (exit $PRC): $LEFT"
echo "   ok  refused by the gate before any research container was created"

echo "== 5/5 evidence files and transfer pieces"
(cd "$EV" && sha256sum preflight-report.json trust-evidence.json negative-controls.json executor-dryrun.json > SHA256SUMS) || stop "cannot hash the evidence"
sed 's/^/   /' "$EV/SHA256SUMS"
echo "   Transfer pieces (copy the numbered lines):"
(cd "$EV" && tar --numeric-owner --owner=0 --group=0 -cf - preflight-report.json trust-evidence.json negative-controls.json executor-dryrun.json | gzip -9n | base64 -w0 | fold -w 400 | nl -w1 -s" " \
  | while read -r n c; do echo "$n $(printf %s "$c" | sha256sum | cut -c1-8) $c"; done) || stop "cannot prepare the transfer pieces"
case "$TRC" in
  0) done_ "PASS: preflight, trust evidence, negative controls and the gated executor dry run all as expected. M1/M3 remain blocked." 0 ;;
  *) done_ "REVIEW: preflight, negative controls and the gated executor dry run as expected; trust evidence has items to review (above). M1/M3 remain blocked." 4 ;;
esac
