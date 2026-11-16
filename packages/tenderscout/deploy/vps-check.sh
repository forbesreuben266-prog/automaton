#!/usr/bin/env bash
# TenderScout VPS pre-flight check. READ-ONLY: changes nothing, restarts nothing.
# Usage: bash vps-check.sh        (sudo optional; gives fuller port/process info)
set -u
line() { printf '\n=== %s ===\n' "$1"; }

line "OS"
. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"; uname -m

line "CPU / RAM / DISK"
echo "CPUs: $(nproc)"
free -m | awk 'NR<=2'
df -h / /var /opt 2>/dev/null | awk '!seen[$0]++'
uptime

line "NODE (system)"
command -v node >/dev/null && node -v || echo "no system node"

line "AUTOMATON processes/services"
ps -eo pid,user,rss,pcpu,etime,args --sort=-rss | grep -Ei 'automaton|conway|dist/index.js' | grep -v grep || echo "none found by name"
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -Ei 'automaton|conway' || echo "no matching systemd unit"
command -v pm2 >/dev/null && pm2 ls 2>/dev/null || true
command -v docker >/dev/null && docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null || true

line "LISTENING PORTS"
ss -ltnp 2>/dev/null | awk 'NR==1 || /LISTEN/'

line "WEB SERVERS / REVERSE PROXY"
for s in caddy nginx apache2 httpd traefik; do
  if command -v "$s" >/dev/null || systemctl list-unit-files 2>/dev/null | grep -q "^$s"; then
    echo "$s: installed, $(systemctl is-active "$s" 2>/dev/null)"
  fi
done
[ -f /etc/caddy/Caddyfile ] && { echo "--- /etc/caddy/Caddyfile (site names only)"; grep -E '^[^#[:space:]].*\{' /etc/caddy/Caddyfile; }

line "FIREWALL"
(ufw status 2>/dev/null || echo "ufw not available/need sudo") | head -15

line "PUBLIC IP"
curl -fsS -4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I

line "EXISTING TENDERSCOUT"
systemctl is-active tenderscout 2>/dev/null || echo "not installed"
echo; echo "Done. Nothing was changed. Paste this whole output back to Claude."
