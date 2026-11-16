#!/usr/bin/env bash
# TenderScout UK - VPS installer (Ubuntu 22.04/24.04). Safe to re-run (also used for updates).
#
#   sudo bash vps-install.sh --domain tenderscout.co.uk [--www] [--port 3310]
#   sudo bash vps-install.sh --local-only        # no domain yet: runs on 127.0.0.1 only, no Caddy
#
# Isolation from Automaton (nothing of Automaton is stopped, restarted or modified):
#  - own system user `tenderscout`, own private Node 22 in /opt/tenderscout/node (system Node untouched)
#  - own systemd unit `tenderscout.service` with memory/CPU caps and low priority
#  - own data dir /var/lib/tenderscout (SQLite), secrets in /etc/tenderscout/tenderscout.env (root-only)
#  - Caddy is installed ONLY if nothing else serves ports 80/443; an existing Caddy gets a separate
#    site file + graceful reload; nginx/apache are never touched (instructions printed instead).
# Safety: always starts in DRY-RUN email mode; live Stripe keys are refused by the app.
set -euo pipefail

REPO="https://github.com/forbesreuben266-prog/automaton.git"
BRANCH="tenderscout-mvp"
NODE_VERSION="22.23.4"
PORT=3310
DOMAIN=""
WWW=0
LOCAL_ONLY=0
APP=/opt/tenderscout
DATA=/var/lib/tenderscout
ENVDIR=/etc/tenderscout
ENVFILE=$ENVDIR/tenderscout.env

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --www) WWW=1; shift ;;
    --port) PORT="$2"; shift 2 ;;
    --local-only) LOCAL_ONLY=1; shift ;;
    *) echo "Unknown option $1"; exit 1 ;;
  esac
done

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARNING: %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mSTOP: %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo."
[ -n "$DOMAIN" ] || [ "$LOCAL_ONLY" -eq 1 ] || die "Give --domain yourdomain or --local-only"
command -v systemctl >/dev/null || die "systemd is required."

# ---------- pre-flight ----------
say "Pre-flight checks"
command -v ss >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-upgrade iproute2 >/dev/null; }
MEM_AVAIL=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
DISK_AVAIL=$(df -Pm /opt | awk 'NR==2 {print $4}')
echo "Available RAM: ${MEM_AVAIL}MB, free disk: ${DISK_AVAIL}MB"
[ "$MEM_AVAIL" -ge 250 ] || die "Less than 250MB RAM available - TenderScout could squeeze Automaton. Add swap/RAM first."
[ "$DISK_AVAIL" -ge 1500 ] || die "Need at least 1.5GB free disk."

# Snapshot other services so we can prove nothing changed
BEFORE=$(systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | awk '{print $1}' | grep -v '^tenderscout' | sort || true)

if ss -ltn "sport = :$PORT" | grep -q LISTEN && ! systemctl is-active --quiet tenderscout; then
  die "Port $PORT is already used by something else. Re-run with --port <free port>."
fi

PROXY=none
if [ "$LOCAL_ONLY" -eq 0 ]; then
  if ss -ltnp 2>/dev/null | grep -E ':(80|443)\s' | grep -q caddy; then PROXY=caddy-existing
  elif ss -ltn 2>/dev/null | grep -Eq ':(80|443)\s'; then PROXY=other
  else PROXY=caddy-new; fi
  echo "Reverse proxy mode: $PROXY"
  PUBIP=$(curl -fsS -4 --max-time 5 https://api.ipify.org || true)
  DNSIP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
  if [ -n "$PUBIP" ] && [ "$DNSIP" != "$PUBIP" ]; then
    warn "$DOMAIN resolves to '${DNSIP:-nothing}', this server is $PUBIP. HTTPS will only work once the DNS A record points here."
  fi
fi

# ---------- packages (additive only) ----------
say "Installing build tools (git, compiler for SQLite driver) - additive, no upgrades of existing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-upgrade git ca-certificates curl xz-utils build-essential python3 >/dev/null

# ---------- user + dirs ----------
id tenderscout >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin tenderscout
mkdir -p "$APP" "$DATA" "$ENVDIR"
chown tenderscout:tenderscout "$APP" "$DATA"; chmod 750 "$DATA"; chmod 750 "$ENVDIR"

# ---------- private Node runtime ----------
ARCH=$(uname -m); case "$ARCH" in x86_64) NARCH=x64 ;; aarch64) NARCH=arm64 ;; *) die "Unsupported CPU $ARCH" ;; esac
NODE_DIR="$APP/node"
if [ ! -x "$NODE_DIR/bin/node" ] || [ "$("$NODE_DIR/bin/node" -v)" != "v$NODE_VERSION" ]; then
  say "Installing private Node v$NODE_VERSION (system Node is not touched)"
  TMP=$(mktemp -d); TAR="node-v$NODE_VERSION-linux-$NARCH.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$TAR" -o "$TMP/$TAR"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  (cd "$TMP" && grep " $TAR\$" SHASUMS256.txt | sha256sum -c -) || die "Node checksum mismatch"
  rm -rf "$NODE_DIR"; mkdir -p "$NODE_DIR"
  tar -xJf "$TMP/$TAR" -C "$NODE_DIR" --strip-components=1
  rm -rf "$TMP"
fi
export PATH="$NODE_DIR/bin:$PATH"

# ---------- code ----------
say "Fetching branch $BRANCH"
SRC="$APP/src"
if [ -d "$SRC/.git" ]; then
  sudo -u tenderscout git -C "$SRC" fetch -q --depth 1 origin "$BRANCH"
  sudo -u tenderscout git -C "$SRC" reset -q --hard FETCH_HEAD
else
  sudo -u tenderscout git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$SRC"
fi
PKG="$SRC/packages/tenderscout"
echo "Commit: $(sudo -u tenderscout git -C "$SRC" rev-parse --short HEAD)"

say "Building (standalone, outside the Automaton workspace)"
cd "$PKG"
sudo -u tenderscout env PATH="$PATH" HOME="$APP" npm install --no-audit --no-fund --loglevel=error --workspaces=false
sudo -u tenderscout env PATH="$PATH" HOME="$APP" npx tsc
sudo -u tenderscout env PATH="$PATH" HOME="$APP" npm prune --omit=dev --no-audit --loglevel=error --workspaces=false

# ---------- config (created once; never overwritten) ----------
if [ "$LOCAL_ONLY" -eq 1 ]; then BASE="http://127.0.0.1:$PORT"; else BASE="https://$DOMAIN"; fi
if [ ! -f "$ENVFILE" ]; then
  say "Creating $ENVFILE (dry-run, no payment keys yet)"
  cat > "$ENVFILE" <<EOF
# TenderScout config. Edit, then: sudo systemctl restart tenderscout
TS_DRY_RUN=true
TS_ALLOW_LIVE_PAYMENTS=false
TS_BASE_URL=$BASE
PORT=$PORT
TS_DATA_DIR=$DATA
TS_CONTACT_EMAIL=
TS_ADMIN_EMAIL=
TS_COMPANY_LEGAL_NAME=
TS_COMPANY_ADDRESS=
TS_COMPANY_NUMBER=
TS_ICO_NUMBER=
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
TS_FROM_EMAIL=
STRIPE_SECRET_KEY=
STRIPE_PRICE_ID=
STRIPE_WEBHOOK_SECRET=
EOF
else
  # keep existing secrets; only keep BASE/PORT in sync
  sed -i "s|^TS_BASE_URL=.*|TS_BASE_URL=$BASE|; s|^PORT=.*|PORT=$PORT|" "$ENVFILE"
fi
chown root:tenderscout "$ENVFILE"; chmod 640 "$ENVFILE"
grep -q '^STRIPE_SECRET_KEY=sk_live_' "$ENVFILE" && ! grep -q '^TS_ALLOW_LIVE_PAYMENTS=true' "$ENVFILE" && warn "A live Stripe key is set; the app will refuse to start payments until TS_ALLOW_LIVE_PAYMENTS=true."

# ---------- systemd ----------
say "Installing tenderscout.service"
cat > /etc/systemd/system/tenderscout.service <<EOF
[Unit]
Description=TenderScout UK (website + 07:00 tender digest)
After=network-online.target
Wants=network-online.target

[Service]
User=tenderscout
Group=tenderscout
WorkingDirectory=$PKG
EnvironmentFile=$ENVFILE
Environment=NODE_ENV=production
ExecStart=$NODE_DIR/bin/node dist/cli.js start
Restart=always
RestartSec=5
# Don't compete with Automaton
Nice=10
MemoryMax=400M
CPUQuota=60%
# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q tenderscout
systemctl restart tenderscout   # restarts ONLY tenderscout

# ---------- seed tenders ----------
say "Seeding tender database from official sources (last 30 days, ~2 min)"
sudo -u tenderscout env PATH="$PATH" TS_DATA_DIR="$DATA" node "$PKG/dist/cli.js" scan --days 30 | tail -12 || warn "Seed scan failed - check outbound HTTPS to find-tender/contractsfinder."

# ---------- HTTPS ----------
if [ "$PROXY" = caddy-new ] || [ "$PROXY" = caddy-existing ]; then
  if [ "$PROXY" = caddy-new ]; then
    say "Installing Caddy (official repository)"
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
    printf '# Managed sites live in /etc/caddy/sites/\nimport /etc/caddy/sites/*.caddy\n' > /etc/caddy/Caddyfile
  fi
  mkdir -p /etc/caddy/sites
  NAMES="$DOMAIN"; [ "$WWW" -eq 1 ] && NAMES="$DOMAIN, www.$DOMAIN"
  cat > /etc/caddy/sites/tenderscout.caddy <<EOF
$NAMES {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
  if ! grep -q 'import /etc/caddy/sites/' /etc/caddy/Caddyfile; then
    warn "Your existing Caddyfile doesn't import /etc/caddy/sites/. Add this line to /etc/caddy/Caddyfile, then run: sudo systemctl reload caddy"
    echo "    import /etc/caddy/sites/*.caddy"
  else
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || die "Caddy config invalid - not reloading. Check /etc/caddy/sites/tenderscout.caddy"
    systemctl enable -q caddy; systemctl reload caddy 2>/dev/null || systemctl restart caddy
  fi
  if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
    ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; echo "ufw: opened 80/443"
  fi
elif [ "$PROXY" = other ]; then
  warn "Another web server already uses ports 80/443 - not touching it. Point $DOMAIN at http://127.0.0.1:$PORT in its config, e.g. nginx:"
  echo "    location / { proxy_pass http://127.0.0.1:$PORT; proxy_set_header Host \$host; proxy_set_header X-Forwarded-For \$remote_addr; }"
fi

# ---------- verify ----------
say "Verifying"
sleep 3
systemctl is-active --quiet tenderscout && echo "tenderscout.service: active" || { journalctl -u tenderscout -n 30 --no-pager; die "service failed to start"; }
curl -fsS "http://127.0.0.1:$PORT/healthz" && echo
curl -fsS -o /dev/null -w "Homepage (local): HTTP %{http_code}\n" "http://127.0.0.1:$PORT/"
if [ "$PROXY" != none ] && [ "$PROXY" != other ]; then
  sleep 5
  curl -fsS -o /dev/null -w "Homepage (https://$DOMAIN): HTTP %{http_code}\n" --max-time 20 "https://$DOMAIN/" \
    || warn "HTTPS not ready yet (DNS not pointing here, or certificate still being issued). Re-check in a few minutes."
fi
AFTER=$(systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | awk '{print $1}' | grep -v '^tenderscout' | sort || true)
MISSING=$(comm -23 <(echo "$BEFORE") <(echo "$AFTER") || true)
if [ -n "$MISSING" ]; then warn "These services were running before and are not now: $MISSING"; else echo "Other services: unchanged (all still running)."; fi
echo
echo "Done. Email mode: DRY-RUN. Config: $ENVFILE  Logs: journalctl -u tenderscout -f"
