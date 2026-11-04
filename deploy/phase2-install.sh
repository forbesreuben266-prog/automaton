#!/usr/bin/env bash
# Automaton Phase 2, Steps 1-3: install Node.js 22 (official tarball, SHA-256
# verified), clone the exact reviewed Automaton commit, install dependencies
# without running install scripts, and build. Nothing here uses Docker, starts
# an agent, uses a paid API or touches Docker/gVisor/AppArmor/UFW/SSH.
#
# Run it as your normal user (it asks for your sudo password once):
#     bash ~/phase2-install.sh
# Running it with "bash" means a STOP ends only the script, never your SSH session.
#
# It refuses to start if Node.js, /opt/node-v<version>, /usr/local/bin/node,
# /usr/local/bin/corepack or ~/automaton already exist (nothing is overwritten).

set -u
set -o pipefail

NODE_VERSION="22.23.4"
NODE_FILE="node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_SHA256="1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
NODE_DIR="/opt/node-v${NODE_VERSION}"
LINK_DIR="/usr/local/bin"
REPO_URL="https://github.com/forbesreuben266-prog/automaton.git"
REPO_BRANCH="custom"
REPO_COMMIT="11b7a78d2fe2eb0cd27c2fe612b6db4f960d91c2"
REPO_DIR="$HOME/automaton"
PNPM_VERSION="10.28.1"

CREATED=()                 # what this run created, for the rollback hint
DL_DIR=""
pass() { echo "  ok    $*"; }
stop() {
  echo ""; echo "STOP: $*"
  if [ "${#CREATED[@]}" -gt 0 ]; then
    echo "This run created the following. Remove them before running again (only after checking):"
    for c in "${CREATED[@]}"; do echo "    $c"; done
  else
    echo "Nothing was installed."
  fi
  exit 1
}
step() { echo ""; echo "== $*"; }
cleanup() { case "$DL_DIR" in "$HOME"/node-download.*) [ -d "$DL_DIR" ] && rm -rf -- "$DL_DIR" ;; esac; return 0; }
trap cleanup EXIT
trap 'echo ""; echo "Interrupted."; stop "interrupted by the user"' INT TERM

echo "Automaton Phase 2 install (Steps 1-3): Node.js $NODE_VERSION, commit ${REPO_COMMIT:0:12}, build."

step "0. Checks before anything is changed"
[ "$(id -u)" != 0 ] || stop "run this as your normal user, not as root (it uses sudo only where needed)"
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || stop "this script is for Linux x86_64 (found $(uname -s) $(uname -m))"
for c in curl sha256sum tar xz git sudo grep; do command -v "$c" >/dev/null 2>&1 || stop "required command '$c' is not installed"; done
pass "Linux x86_64; curl, sha256sum, tar, xz, git and sudo are available"
if command -v node >/dev/null 2>&1; then stop "Node.js is already installed at $(command -v node) ($(node -v 2>/dev/null)); this script will not replace it"; fi
for p in "$NODE_DIR" "$LINK_DIR/node" "$LINK_DIR/corepack" "$REPO_DIR"; do
  if [ -e "$p" ] || [ -L "$p" ]; then stop "$p already exists; this script never overwrites anything"; fi
done
pass "no existing Node.js, $NODE_DIR, $LINK_DIR/node, $LINK_DIR/corepack or $REPO_DIR"
echo "  sudo will ask for your password once (needed to install into $NODE_DIR and $LINK_DIR)."
sudo -v || stop "sudo is needed for the installation step"
pass "sudo available"

step "1. Download Node.js $NODE_VERSION and verify its SHA-256 (twice)"
DL_DIR="$(mktemp -d "$HOME/node-download.XXXXXX")" || stop "cannot create a download folder"
curl -fsSL --proto '=https' --tlsv1.2 -o "$DL_DIR/$NODE_FILE" "$NODE_URL/$NODE_FILE" || stop "download of $NODE_FILE failed"
curl -fsSL --proto '=https' --tlsv1.2 -o "$DL_DIR/SHASUMS256.txt" "$NODE_URL/SHASUMS256.txt" || stop "download of SHASUMS256.txt failed"
LINES="$(grep -c "  ${NODE_FILE}\$" "$DL_DIR/SHASUMS256.txt")" || LINES=0
[ "$LINES" = 1 ] || stop "SHASUMS256.txt does not list $NODE_FILE exactly once"
MANIFEST_SHA="$(grep "  ${NODE_FILE}\$" "$DL_DIR/SHASUMS256.txt" | cut -d' ' -f1)" || stop "cannot read the checksum manifest"
[ "$MANIFEST_SHA" = "$NODE_SHA256" ] || stop "the official checksum manifest ($MANIFEST_SHA) differs from the reviewed value ($NODE_SHA256)"
ACTUAL_SHA="$(sha256sum "$DL_DIR/$NODE_FILE" | cut -d' ' -f1)" || stop "cannot hash the download"
[ "$ACTUAL_SHA" = "$NODE_SHA256" ] || stop "the downloaded file's SHA-256 ($ACTUAL_SHA) does not match ($NODE_SHA256)"
pass "SHA-256 $ACTUAL_SHA matches both the official manifest and the reviewed value"

step "2. Install Node.js into $NODE_DIR (root-owned) and link it from $LINK_DIR"
sudo mkdir "$NODE_DIR" || stop "cannot create $NODE_DIR"
CREATED+=("$NODE_DIR   (sudo rm -rf $NODE_DIR)")
sudo tar -xJf "$DL_DIR/$NODE_FILE" -C "$NODE_DIR" --strip-components=1 --no-same-owner || stop "extracting Node.js failed"
[ -x "$NODE_DIR/bin/node" ] && [ "$(stat -c %u "$NODE_DIR/bin/node")" = 0 ] || stop "$NODE_DIR/bin/node is missing or not root-owned"
# Every entry root-owned; no real file or folder world-writable (symlinks always show 777, so their mode is ignored).
[ -z "$(sudo find "$NODE_DIR" \( ! -user root -o \( ! -type l -perm -0002 \) \) -print -quit)" ] || stop "$NODE_DIR contains entries that are not root-owned or are world-writable"
sudo ln -s "$NODE_DIR/bin/node" "$LINK_DIR/node" || stop "cannot create $LINK_DIR/node"
CREATED+=("$LINK_DIR/node   (sudo rm $LINK_DIR/node)")
sudo ln -s "$NODE_DIR/bin/corepack" "$LINK_DIR/corepack" || stop "cannot create $LINK_DIR/corepack"
CREATED+=("$LINK_DIR/corepack   (sudo rm $LINK_DIR/corepack)")
hash -r
[ "$(node -v 2>/dev/null)" = "v$NODE_VERSION" ] || stop "node -v does not print v$NODE_VERSION"
[ "$(sudo node -v 2>/dev/null)" = "v$NODE_VERSION" ] || stop "sudo node -v does not print v$NODE_VERSION (sudo cannot find it)"
pass "node v$NODE_VERSION for you and for sudo"

step "3. Clone the exact reviewed Automaton commit"
git clone --quiet --branch "$REPO_BRANCH" "$REPO_URL" "$REPO_DIR" || stop "git clone failed"
CREATED+=("$REPO_DIR   (rm -rf $REPO_DIR)")
git -C "$REPO_DIR" checkout --quiet --detach "$REPO_COMMIT" || stop "commit $REPO_COMMIT is not on branch $REPO_BRANCH"
[ "$(git -C "$REPO_DIR" rev-parse HEAD)" = "$REPO_COMMIT" ] || stop "the checked-out commit is not $REPO_COMMIT"
[ -z "$(git -C "$REPO_DIR" status --porcelain)" ] || stop "the checkout is not clean"
pass "checked out $REPO_COMMIT (clean)"

step "4. Install dependencies (locked versions, no install scripts) and build"
cd "$REPO_DIR" || stop "cannot enter $REPO_DIR"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
[ "$(corepack pnpm --version 2>/dev/null)" = "$PNPM_VERSION" ] || stop "corepack did not provide pnpm $PNPM_VERSION"
pass "pnpm $PNPM_VERSION (via corepack)"
corepack pnpm install --frozen-lockfile --ignore-scripts || stop "pnpm install failed"
pass "dependencies installed exactly as locked"
./node_modules/.bin/tsc || stop "the TypeScript build failed"
for f in dist/research-sandbox/preflight-main.js dist/research-sandbox/canary-probe.js dist/research-sandbox/canary.js dist/research-cli/main.js; do
  [ -f "$f" ] || stop "the build did not produce $f"
done
pass "build output present (research sandbox and research CLI)"
node dist/research-sandbox/preflight-main.js > /dev/null 2>&1; RC=$?
[ "$RC" = 2 ] || stop "the preflight runner's self-check returned $RC (expected 2: usage error, no Docker call)"
pass "preflight runner starts and refuses without arguments (no Docker call)"
[ -z "$(git status --porcelain)" ] || stop "the build changed tracked files (git status is not clean)"

echo ""
echo "PASS: Node.js $NODE_VERSION installed, Automaton $REPO_COMMIT cloned and built in $REPO_DIR."
echo "Nothing has used Docker. Step 4 (host-setup.sh) still needs its own approval."
