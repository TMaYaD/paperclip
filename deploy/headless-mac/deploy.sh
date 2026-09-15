#!/usr/bin/env bash
# deploy/headless-mac/deploy.sh — deploy this checkout's HEAD onto the managed
# paperclipai install, driven by gitmon (https://github.com/TMaYaD/gitmon).
#
# gitmon runs this script as its child inside a clone of the fork's `main`.
# When `main` changes it pulls and restarts the script, which then:
#
#   1. compares HEAD with the sha recorded in ~/.paperclip/cli/install.json
#   2. backs up the database (paperclipai db:backup)
#   3. builds and installs HEAD with `paperclipai install --ref <sha>`
#      (a full sha needs no api.github.com lookup; see cli/src/commands/install.ts)
#   4. waits for a quiet window: no agent processes and no run-log writes
#   5. restarts the ing.paperclip.paperclipai LaunchDaemon
#   6. checks /api/health and rolls the payload back if the server stays down
#
# and finally parks until gitmon restarts it for the next change. At boot HEAD
# normally equals the installed sha, so the script only parks.
#
# Everything is configurable through the environment (set in the LaunchDaemon
# plist next to this file). Database migrations are not reversible: the backup
# taken in step 2 is the real rollback for a bad deploy; the payload rollback in
# step 6 only puts the previous code back.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PAPERCLIP_HOME="${PAPERCLIP_HOME:-$HOME/.paperclip}"
INSTANCE_ID="${PAPERCLIP_INSTANCE_ID:-default}"
INSTANCE_ROOT="$PAPERCLIP_HOME/instances/$INSTANCE_ID"
PAPERCLIPAI="${PAPERCLIPAI_BIN:-$HOME/.local/bin/paperclipai}"

DEPLOY_REPO="${PAPERCLIP_DEPLOY_REPO:-TMaYaD/paperclip}"
DAEMON_LABEL="${PAPERCLIP_DEPLOY_DAEMON_LABEL:-ing.paperclip.paperclipai}"
DAEMON_PLIST="${PAPERCLIP_DEPLOY_DAEMON_PLIST:-/Library/LaunchDaemons/$DAEMON_LABEL.plist}"
API_BASE="${PAPERCLIP_DEPLOY_API_BASE:-http://127.0.0.1:3100}"
# now  = build as soon as a change lands (the build loads the host for ~45 min)
# idle = also wait for a quiet window before building
BUILD_WHEN="${PAPERCLIP_DEPLOY_BUILD_WHEN:-now}"
QUIET_MINUTES="${PAPERCLIP_DEPLOY_QUIET_MINUTES:-2}"      # no run-log writes for this long
QUIET_MAX_WAIT="${PAPERCLIP_DEPLOY_QUIET_MAX_WAIT:-7200}"  # seconds; 0 = wait forever
HEALTH_TIMEOUT="${PAPERCLIP_DEPLOY_HEALTH_TIMEOUT:-240}"   # seconds after a restart
INSTALL_ATTEMPTS="${PAPERCLIP_DEPLOY_INSTALL_ATTEMPTS:-3}"
INSTALL_RETRY_DELAY="${PAPERCLIP_DEPLOY_INSTALL_RETRY_DELAY:-600}"
# processes that mean an agent turn is in flight (all local adapter lanes)
AGENT_PROCESS_PATTERN="${PAPERCLIP_DEPLOY_AGENT_PATTERN:-claude-agent-acp|acpx-runtime-sidecar|codex-acp|claude --print|codex exec}"

log() { printf '[%s] deploy: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

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
  node -e 'try { const m = require(process.argv[1]); process.stdout.write(String(m.sha || "")); } catch { process.stdout.write(""); }' "$manifest"
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

log "database backup"
"$PAPERCLIPAI" db:backup --json 2>/dev/null | grep -E '"backupFile"' || log "warning: backup did not report a file"

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
