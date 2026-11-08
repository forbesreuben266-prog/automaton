#!/usr/bin/env bash
# ONE supervised, paid, end-to-end venture-engine cycle with the Claude API.
# Run it yourself, on the VPS, as your own user, ONLY after you have approved paid usage and its maximum cost.
# It never edits config.json, never installs a schedule, never publishes anything and runs exactly one cycle.
#
#   scripts/venture-supervised-e2e.sh --max-gbp 1.00 --i-approve-paid-usage
#
# Refuses unless: the approval flag is given; config.json selects provider "claude" with paidUsageApproved true;
# model.maxGbpPerRun is at or below --max-gbp; the engine is not stopped; the key file is mode 600; and the local
# ledger has at least --max-gbp left. The ledger is the engine's own estimate, NOT a provider-enforced cap:
# set a spend limit (or prepaid credit only) in the Anthropic Console as well.
set -euo pipefail

MAX=""; OK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max-gbp) MAX="${2:-}"; shift 2 ;;
    --i-approve-paid-usage) OK=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ "$OK" = 1 ] || { echo "refused: pass --i-approve-paid-usage" >&2; exit 2; }
[[ "$MAX" =~ ^[0-9]+(\.[0-9]{1,2})?$ ]] || { echo "refused: --max-gbp must be an amount such as 1.00" >&2; exit 2; }

DATA="$HOME/.automaton-ventures"
APP="$HOME/automaton/dist/venture-engine/main.js"
CFG="$DATA/config.json"
[ -f "$APP" ] && [ -f "$CFG" ] || { echo "refused: build the app and run 'config' once first" >&2; exit 2; }
[ ! -e "$DATA/STOP" ] || { echo "refused: the engine is stopped (STOP file)" >&2; exit 2; }
[ "$(stat -c %a "$DATA/anthropic.key" 2>/dev/null)" = 600 ] || { echo "refused: $DATA/anthropic.key must exist with mode 600" >&2; exit 2; }

node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const max = Number(process.argv[2]);
  const m = c.model, bad = [];
  if (m.provider !== "claude") bad.push("model.provider is not claude");
  if (m.paidUsageApproved !== true) bad.push("model.paidUsageApproved is not true");
  if (!(m.maxGbpPerRun > 0 && m.maxGbpPerRun <= max)) bad.push(`model.maxGbpPerRun (${m.maxGbpPerRun}) must be set and at most ${max}`);
  if (c.schedule.enabled !== false) bad.push("schedule.enabled must be false for a supervised test");
  if (bad.length) { console.error("refused: " + bad.join("; ")); process.exit(2); }
  console.log(`model ${m.name}, up to ${m.maxCallsPerCycle} call(s), this run capped at £${m.maxGbpPerRun} by the local ledger`);
' "$CFG" "$MAX"

before=$(node "$APP" ledger)
echo "before: $before"
if [ -f "$DATA/ledger.json" ]; then
  node -e '
    const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const c = l.entries.reduce((a, e) => a + (e.status === "settled" ? e.actualGbp : e.status === "released" ? 0 : e.reservedGbp), 0);
    if (l.capGbp - c < Number(process.argv[2])) { console.error(`refused: only £${(l.capGbp - c).toFixed(4)} left in the ledger`); process.exit(2); }
  ' "$DATA/ledger.json" "$MAX"
fi

# Free check first (no tokens, nothing reserved): the key is accepted and the model is available to it.
node "$APP" claude-check || { echo "refused: claude-check failed; nothing was spent" >&2; exit 2; }

read -r -p "Type RUN to make up to £$MAX of paid Claude calls now: " answer
[ "$answer" = RUN ] || { echo "cancelled; nothing was run"; exit 0; }

audit_lines=$(wc -l < "$DATA/audit.jsonl" 2>/dev/null || echo 0)
node "$APP" run 1 --paid
echo "--- model activity in this run (from the audit log) ---"
tail -n +"$((audit_lines + 1))" "$DATA/audit.jsonl" 2>/dev/null | grep '"kind":"model-' || echo "(no model entries)"
echo "--- after ---"
node "$APP" ledger
node "$APP" status
echo "Compare the ledger with the Anthropic Console usage page; the Console figure is the real one."
