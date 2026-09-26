# Generic macOS deployment with gitmon

This directory contains a reusable deployment script and a launchd configuration
generator. It contains no operator configuration. Keep service-account names,
paths, network addresses, and generated plists outside the Git checkout.

## Configure an installation

1. Install a compatible Node.js runtime, Git, gitmon, and the managed Paperclip CLI.
2. Clone the repository and select the branch to monitor.
3. Copy `config.example.json` to a private directory outside the checkout. Replace
   every placeholder. Set `api_base` to the actual address on which the server
   listens; a server bound to a specific interface may not accept loopback requests.
4. Optionally set `git_exec_path` if the Git installation needs it under launchd.
   `paperclip_home` defaults to `.paperclip` under the configured home directory.
   `daemon_label` defaults to `ing.paperclip.paperclipai`.
5. Render a plist outside the checkout:

   ```sh
   python3 deploy/macos/render-launchd.py /private/config/deployment.json /private/config/ing.paperclip.gitmon.plist
   plutil -lint /private/config/ing.paperclip.gitmon.plist
   ```

   The generator refuses placeholders, relative home/checkout paths, files inside
   the checkout, and overwriting an existing output. It creates the output with
   owner-only permissions. Use a new output filename when updating configuration.
6. Ensure the instance log directory exists. Install the generated plist into
   `/Library/LaunchDaemons/` with root ownership and mode `0644`, then bootstrap it
   with `sudo launchctl bootstrap system /Library/LaunchDaemons/ing.paperclip.gitmon.plist`.
7. The deployment account must be able to perform the script's noninteractive
   service restart commands. Have the system administrator configure narrowly
   scoped permissions for the selected daemon.

Do not commit the rendered plist or the operator JSON. Do not put credentials in
the repository URL or health-check URL. Configure private-repository access in
the account's credential provider and verify the installer's archive-download
authentication separately.

## Deployment behavior

gitmon monitors the selected branch. On an update, `deploy.sh` compares the
checkout revision with the installed payload, attempts a database backup,
installs the revision, waits for a quiet period, and restarts the application.
It checks `/api/health` and restores the previous payload if startup fails.
Payload rollback does not undo database migrations.

`PAPERCLIP_DEPLOY_REPO` and `PAPERCLIP_DEPLOY_API_BASE` are required. The generated
plist supplies them from the private JSON. Other settings include
`PAPERCLIP_DEPLOY_BUILD_WHEN`, `PAPERCLIP_DEPLOY_QUIET_MINUTES`,
`PAPERCLIP_DEPLOY_QUIET_MAX_WAIT`, `PAPERCLIP_DEPLOY_HEALTH_TIMEOUT`,
`PAPERCLIP_DEPLOY_INSTALL_ATTEMPTS`, and `PAPERCLIP_DEPLOY_INSTALL_RETRY_DELAY`.

Pause monitoring with `sudo launchctl bootout system/ing.paperclip.gitmon`.
Reload the installed plist after configuration changes. Review the instance's
`gitmon.log` and `gitmon.err.log` for deployment results.

After a repository history rewrite, replace or rebase old clones; do not merge
the old history back into a cleaned branch.

An operator who has verified that an installed payload is unchanged by a history
rewrite can supply `revision_map` in the private configuration. This is an
absolute path to a private JSON object mapping the installed full SHA to its
verified equivalent full SHA. The script logs use of the mapping and avoids an
unnecessary reinstall. It does not change the install manifest. Do not map
revisions with different application behavior. Later commits deploy normally.
