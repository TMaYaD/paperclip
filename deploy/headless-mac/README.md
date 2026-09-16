# Continuous deploy of `main` to the headless Mac

The fork's `main` is the deploy branch. On the headless Mac,
[gitmon](https://github.com/TMaYaD/gitmon) watches a clone of it and, whenever
it moves, runs [`deploy.sh`](./deploy.sh), which builds the new commit into a
managed `paperclipai` payload and restarts the server in a quiet window.

## How a deploy runs

1. gitmon (`-i 300`) fetches every five minutes over HTTPS. That is plain git,
   so it never spends the host's anonymous GitHub API quota, which the agents
   on the same box exhaust within minutes of every hourly reset.
2. On a change gitmon pulls and restarts `deploy.sh`.
3. `deploy.sh` compares `git rev-parse HEAD` with `sha` in
   `~/.paperclip/cli/install.json`. Equal means nothing to do (this is the boot
   case), so it parks until gitmon restarts it.
4. Otherwise it takes a database backup, then runs
   `paperclipai install --ref <full sha> --repo TMaYaD/paperclip --yes`. The
   installer downloads the tarball for that sha and builds it into
   `~/.paperclip/cli/installs/git/<sha12>` (about 45 minutes on this Mac), then
   flips `~/.paperclip/cli/current`. A full sha skips the api.github.com ref
   lookup entirely (`cli/src/commands/install.ts`), which is what keeps this
   unattended. The install is retried three times, ten minutes apart.
5. It waits for a quiet window: no agent processes and no run log written for
   two minutes, bounded by two hours, then `launchctl kickstart -k` restarts
   `ing.paperclip.paperclipai`, which drains runs gracefully.
6. It polls `/api/health` for up to four minutes. If the server does not come
   up it runs `paperclipai update --rollback`, restarts again, and parks with a
   `ROLLED BACK` line in the log. Migrations are not reversed by that; the
   backup from step 4 is the real rollback.

Knobs are environment variables read by `deploy.sh` and set in the plist:
`PAPERCLIP_DEPLOY_BUILD_WHEN` (`now` or `idle`), `PAPERCLIP_DEPLOY_QUIET_MINUTES`,
`PAPERCLIP_DEPLOY_QUIET_MAX_WAIT`, `PAPERCLIP_DEPLOY_HEALTH_TIMEOUT`,
`PAPERCLIP_DEPLOY_INSTALL_ATTEMPTS`, `PAPERCLIP_DEPLOY_INSTALL_RETRY_DELAY`,
`PAPERCLIP_DEPLOY_AGENT_PATTERN`, `PAPERCLIP_DEPLOY_API_BASE`,
`PAPERCLIP_DEPLOY_DAEMON_LABEL`.

## One-time setup on the Mac

Run as `paperclipai`. Prerequisites already on the box: the managed
`paperclipai` install at `~/.local/bin/paperclipai`, node 24 at
`~/opt/node24/bin`, git at `~/.local/bin/git` (a custom build under
`~/opt/git`; the plist sets `GIT_EXEC_PATH` so its remote helpers resolve
under launchd), and passwordless `sudo` for `launchctl`.

```sh
# 1. gitmon binary: the release asset is a bare executable, not an archive
#    (pin the version; check https://github.com/TMaYaD/gitmon/releases)
mkdir -p ~/.local/bin
curl -fsSL -o ~/.local/bin/gitmon \
  https://github.com/TMaYaD/gitmon/releases/download/v0.10.0/gitmon-darwin-amd64
chmod +x ~/.local/bin/gitmon
~/.local/bin/gitmon -h

# 2. the clone gitmon watches (HTTPS: public repo, no credentials needed)
mkdir -p ~/gitmon
git clone --branch main https://github.com/TMaYaD/paperclip.git ~/gitmon/paperclip
chmod +x ~/gitmon/paperclip/deploy/headless-mac/deploy.sh

# 3. the LaunchDaemon (root-owned, like ing.paperclip.paperclipai)
sudo cp ~/gitmon/paperclip/deploy/headless-mac/ing.paperclip.gitmon.plist /Library/LaunchDaemons/
sudo chown root:wheel /Library/LaunchDaemons/ing.paperclip.gitmon.plist
sudo chmod 644 /Library/LaunchDaemons/ing.paperclip.gitmon.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/ing.paperclip.gitmon.plist
```

Check it: `sudo launchctl print system/ing.paperclip.gitmon | grep state` should
say running, and `~/.paperclip/instances/default/logs/gitmon.log` should end
with `installed payload already at <sha>; waiting for gitmon` once the clone
and the installed payload match.

The first deploy after this lands still needs the sha shortcut in the
*installed* CLI. If the running payload predates it, either deploy `main` once
by hand (`paperclipai install --ref main ...` while the daemon is stopped, as
before) or let the three retries ride out the API quota.

## Day to day

- Merge to `main`; within five minutes gitmon picks it up. Follow along in
  `gitmon.log`. A deploy ends with `deployed <sha>; ... healthy`.
- A second push during a build makes gitmon kill the running script; the next
  run rebuilds the newer sha. Nothing half-applied results, but the interrupted
  build's time is lost.
- Build load: the build runs on the server host at high load for its duration.
  Set `PAPERCLIP_DEPLOY_BUILD_WHEN` to `idle` in the plist to gate the build,
  not just the restart, on a quiet window.
- To pause deploys: `sudo launchctl bootout system/ing.paperclip.gitmon`. To
  resume: bootstrap it again. To change the plist, edit the copy in the repo,
  merge, then re-copy and bootout/bootstrap (launchd reads the installed copy).
- Rollback by hand: `paperclipai update --rollback` then
  `sudo launchctl kickstart -k system/ing.paperclip.paperclipai`. The two
  previous payloads are retained. Restore the backup from
  `~/.paperclip/instances/default/data/backups/` if the schema moved.
