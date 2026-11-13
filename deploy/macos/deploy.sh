#!/usr/bin/env bash
# Deploy the monitored checkout through the managed Paperclip installer.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PAPERCLIP_HOME="${PAPERCLIP_HOME:-$HOME/.paperclip}"
INSTANCE_ID="${PAPERCLIP_INSTANCE_ID:-default}"
INSTANCE_ROOT="$PAPERCLIP_HOME/instances/$INSTANCE_ID"
PAPERCLIPAI="${PAPERCLIPAI_BIN:-$HOME/.local/bin/paperclipai}"

DEPLOY_REPO="${PAPERCLIP_DEPLOY_REPO:?Set PAPERCLIP_DEPLOY_REPO to the repository owner/name}"
DAEMON_LABEL="${PAPERCLIP_DEPLOY_DAEMON_LABEL:-ing.paperclip.paperclipai}"
DAEMON_PLIST="${PAPERCLIP_DEPLOY_DAEMON_PLIST:-/Library/LaunchDaemons/$DAEMON_LABEL.plist}"
API_BASE="${PAPERCLIP_DEPLOY_API_BASE:?Set PAPERCLIP_DEPLOY_API_BASE to the server bind URL}"
# now  = build as soon as a change lands 
# idle = also wait for a quiet window before building
BUILD_WHEN="${PAPERCLIP_DEPLOY_BUILD_WHEN:-now}"
QUIET_MINUTES="${PAPERCLIP_DEPLOY_QUIET_MINUTES:-2}"      # no run-log writes for this long
QUIET_MAX_WAIT="${PAPERCLIP_DEPLOY_QUIET_MAX_WAIT:-7200}"  # seconds; 0 = wait forever
HEALTH_TIMEOUT="${PAPERCLIP_DEPLOY_HEALTH_TIMEOUT:-240}"   # seconds after a restart
INSTALL_ATTEMPTS="${PAPERCLIP_DEPLOY_INSTALL_ATTEMPTS:-3}"
INSTALL_RETRY_DELAY="${PAPERCLIP_DEPLOY_INSTALL_RETRY_DELAY:-600}"
# processes that mean an agent turn is in flight (all local adapter lanes)
AGENT_PROCESS_PATTERN="${PAPERCLIP_DEPLOY_AGENT_PATTERN:-claude-agent-acp|acpx-runtime-sidecar|codex-acp|claude --print|codex exec}"

# Native Paperclip Runner (paperclip-runnerd). `paperclipai install --ref` only
# compiles the daemon when `cargo` is on PATH; without it the payload still
# builds but ships no runner binary. So the script keeps a Rust toolchain that
# matches the checkout's pin and exposes it to the installer.
#   auto    = provision the toolchain if the checkout pins one; a failure is
#             logged and the deploy continues without the runner (default)
#   require = a missing toolchain or runner binary blocks the deploy
#   off     = never touch Rust; the payload ships without the runner
BUILD_RUNNER="${PAPERCLIP_DEPLOY_BUILD_RUNNER:-auto}"
RUNNER_TOOLCHAIN_FILE="$REPO_ROOT/packages/paperclip-runner/rust-toolchain.toml"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
RUSTUP_DIST="${PAPERCLIP_DEPLOY_RUSTUP_DIST:-https://static.rust-lang.org/rustup/dist}"

log() { printf '[%s] deploy: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

case "$BUILD_RUNNER" in
  auto|require|off) ;;
  *) echo "deploy: PAPERCLIP_DEPLOY_BUILD_RUNNER must be auto, require or off" >&2; exit 2 ;;
esac

# Block until gitmon restarts us. `sleep` runs in the background and we `wait`
# on it so the TERM trap fires promptly instead of after the sleep.
park() {
  log "$1"
  while true; do
    sleep 3600 &
    wait $!
  done
}
trap 'log "stopping on signal"; exit 0' TERM INT

installed_sha() {
  local manifest="$PAPERCLIP_HOME/cli/install.json"
  [ -f "$manifest" ] || { echo ""; return; }
  node - "$manifest" "${PAPERCLIP_DEPLOY_REVISION_MAP:-}" <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const actual = String(manifest.sha || '');
let effective = actual;
if (process.argv[3]) {
  const aliases = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  if (Object.prototype.hasOwnProperty.call(aliases, actual)) {
    if (!/^[a-f0-9]{40}$/.test(aliases[actual])) throw new Error('Invalid verified revision alias');
    effective = aliases[actual];
    console.error(`deploy: verified history-rewrite equivalence ${actual} -> ${effective}`);
  }
}
process.stdout.write(effective);
NODE
}

# Prints "<agent process count> <run logs written in the last QUIET_MINUTES>".
agent_activity() {
  local procs recent
  procs=$(pgrep -f "$AGENT_PROCESS_PATTERN" | wc -l | tr -d ' ')
  recent=$(find "$INSTANCE_ROOT/data/run-logs" -type f -name '*.ndjson' -mmin "-$QUIET_MINUTES" 2>/dev/null | wc -l | tr -d ' ')
  echo "$procs $recent"
}

wait_for_quiet() {
  local waited=0 procs recent
  while true; do
    read -r procs recent <<<"$(agent_activity)"
    if [ "$procs" = 0 ] && [ "$recent" = 0 ]; then
      log "quiet window: no agent processes, no run activity for ${QUIET_MINUTES}m"
      return 0
    fi
    if [ "$QUIET_MAX_WAIT" != 0 ] && [ "$waited" -ge "$QUIET_MAX_WAIT" ]; then
      log "no quiet window within ${QUIET_MAX_WAIT}s (agents=$procs recent_runs=$recent); proceeding anyway"
      return 0
    fi
    sleep 30
    waited=$((waited + 30))
  done
}

healthy() { curl -s -m 5 "$API_BASE/api/health" | grep -q '"status":"ok"'; }

wait_healthy() {
  local waited=0
  until healthy; do
    sleep 5
    waited=$((waited + 5))
    [ "$waited" -ge "$HEALTH_TIMEOUT" ] && return 1
  done
  return 0
}

# kickstart -k restarts a loaded job with a graceful SIGTERM drain; if the job
# is not loaded (someone booted it out), bootstrap it from the plist instead.
restart_daemon() {
  if sudo -n launchctl print "system/$DAEMON_LABEL" >/dev/null 2>&1; then
    sudo -n launchctl kickstart -k "system/$DAEMON_LABEL"
  else
    log "$DAEMON_LABEL is not loaded; bootstrapping it from $DAEMON_PLIST"
    sudo -n launchctl bootstrap system "$DAEMON_PLIST"
  fi
}

# Install rustup (no toolchain yet) into CARGO_HOME/RUSTUP_HOME. The installer
# binary is checked against the digest Rust publishes beside it.
install_rustup() {
  local triple tmp expected actual
  case "$(uname -s)/$(uname -m)" in
    Darwin/x86_64) triple=x86_64-apple-darwin ;;
    Darwin/arm64) triple=aarch64-apple-darwin ;;
    *) log "no rustup installer for $(uname -sm)"; return 1 ;;
  esac
  tmp=$(mktemp -d) || return 1
  log "installing rustup from $RUSTUP_DIST/$triple"
  if ! curl -fsSL --retry 3 -o "$tmp/rustup-init" "$RUSTUP_DIST/$triple/rustup-init" ||
     ! curl -fsSL --retry 3 -o "$tmp/rustup-init.sha256" "$RUSTUP_DIST/$triple/rustup-init.sha256"; then
    rm -rf "$tmp"; log "rustup download failed"; return 1
  fi
  expected=$(awk '{print $1; exit}' "$tmp/rustup-init.sha256")
  actual=$(shasum -a 256 "$tmp/rustup-init" | awk '{print $1}')
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    rm -rf "$tmp"; log "rustup-init checksum mismatch (expected ${expected:-none}, got $actual)"; return 1
  fi
  chmod 700 "$tmp/rustup-init"
  if ! "$tmp/rustup-init" -y --no-modify-path --profile minimal --default-toolchain none; then
    rm -rf "$tmp"; log "rustup-init failed"; return 1
  fi
  rm -rf "$tmp"
}

# Make `cargo` resolve to the checkout's pinned toolchain for the installer and
# the builds it spawns. Idempotent: with the toolchain already present this
# makes no network calls. Returns non-zero when no working toolchain results.
ensure_runner_toolchain() {
  local channel
  if [ ! -f "$RUNNER_TOOLCHAIN_FILE" ]; then
    log "checkout pins no runner toolchain; the runner build is not required"
    return 0
  fi
  channel=$(sed -n 's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$RUNNER_TOOLCHAIN_FILE" | head -1)
  if [ -z "$channel" ]; then
    log "cannot read the toolchain channel from $RUNNER_TOOLCHAIN_FILE"
    return 1
  fi
  if ! command -v cc >/dev/null 2>&1; then
    log "no C compiler/linker on PATH; install the Xcode command line tools"
    return 1
  fi
  export PATH="$CARGO_HOME/bin:$PATH"
  if ! command -v rustup >/dev/null 2>&1; then
    install_rustup || return 1
  fi
  if ! rustup toolchain list | grep -q "^$channel-"; then
    log "installing Rust $channel for the native runner"
    rustup toolchain install "$channel" --profile minimal --component rustfmt --no-self-update || return 1
  fi
  # Selects the toolchain from any directory; the installer builds in a staging
  # tree where the checkout's rust-toolchain.toml would not be found.
  export RUSTUP_TOOLCHAIN="$channel"
  if ! cargo --version >/dev/null 2>&1 || ! rustc --version >/dev/null 2>&1; then
    log "Rust $channel is installed but cargo/rustc do not run"
    return 1
  fi
  log "runner toolchain: $(cargo --version), $(rustc --version)"
}

# The staged payload keeps a marker instead of a binary when the build skipped it.
runner_binary_present() {
  local bin="$PAPERCLIP_HOME/cli/current/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/bin"
  [ -d "$bin" ] && [ ! -e "$bin/.paperclip-runnerd-skipped" ] &&
    [ -n "$(find "$bin" -name paperclip-runnerd -type f 2>/dev/null | head -1)" ]
}

cd "$REPO_ROOT"
target_sha=$(git rev-parse HEAD)
current_sha=$(installed_sha)
log "checkout HEAD $target_sha: $(git log -1 --format=%s | cut -c1-80)"

if [ "$target_sha" = "$current_sha" ]; then
  park "installed payload already at $target_sha; waiting for gitmon"
fi
log "installed payload is ${current_sha:-unknown}; deploying $target_sha"

# A build that gitmon interrupted (a second push mid-build) can leave a staging
# directory behind; the installer never reuses one, so clear old ones.
find "$PAPERCLIP_HOME/cli/installs/git" -maxdepth 1 -name '.*.tmp-*' -mmin +1440 -exec rm -rf {} + 2>/dev/null || true

if [ "$BUILD_WHEN" = idle ]; then
  log "waiting for a quiet window before building"
  wait_for_quiet
fi

# Cold Rust builds are CPU-heavy, so this runs after the quiet window.
if [ "$BUILD_RUNNER" != off ]; then
  [ "$BUILD_RUNNER" = require ] && export PAPERCLIP_RUNNER_REQUIRE_BINARY=1
  if ! ensure_runner_toolchain; then
    if [ "$BUILD_RUNNER" = require ]; then
      park "runner toolchain unavailable and PAPERCLIP_DEPLOY_BUILD_RUNNER=require; payload unchanged; waiting for the next push"
    fi
    log "warning: continuing without a runner toolchain; the payload will ship without paperclip-runnerd"
  fi
fi

log "database backup"
backup_started=$(date +%s)
"$PAPERCLIPAI" db:backup --json 2>/dev/null | grep -E '"(backupFile|engine|engineFallbackReason)"' || log "warning: backup did not report a file"
log "database backup took $(( $(date +%s) - backup_started ))s"

attempt=1
until "$PAPERCLIPAI" install --ref "$target_sha" --repo "$DEPLOY_REPO" --yes; do
  if [ "$attempt" -ge "$INSTALL_ATTEMPTS" ]; then
    park "install of $target_sha failed after $attempt attempt(s); payload unchanged; waiting for the next push"
  fi
  attempt=$((attempt + 1))
  log "install failed; attempt $attempt/$INSTALL_ATTEMPTS in ${INSTALL_RETRY_DELAY}s"
  sleep "$INSTALL_RETRY_DELAY"
done

new_sha=$(installed_sha)
if [ "$new_sha" != "$target_sha" ]; then
  park "install finished but install.json records ${new_sha:-nothing}; not restarting"
fi

if [ "$BUILD_RUNNER" != off ] && [ -f "$RUNNER_TOOLCHAIN_FILE" ]; then
  if runner_binary_present; then
    log "payload includes paperclip-runnerd"
  else
    log "warning: payload has no paperclip-runnerd; native Runner agents cannot start until a build with a Rust toolchain is installed"
  fi
fi

log "payload $target_sha installed; waiting for a quiet window to restart $DAEMON_LABEL"
wait_for_quiet
log "restarting $DAEMON_LABEL"
restart_daemon
if wait_healthy; then
  park "deployed $target_sha; $DAEMON_LABEL healthy; waiting for gitmon"
fi

log "server not healthy within ${HEALTH_TIMEOUT}s; rolling the payload back"
"$PAPERCLIPAI" update --rollback --yes || log "rollback command failed"
restart_daemon || log "restart after rollback failed"
if wait_healthy; then
  park "ROLLED BACK to $(installed_sha) after a failed deploy of $target_sha; waiting for gitmon"
fi
park "server unhealthy after rollback; manual attention needed"
