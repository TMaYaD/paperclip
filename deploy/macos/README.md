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

### Native Runner build

The installer compiles `paperclip-runnerd` only when `cargo` is on `PATH`. On a
host without it the payload still builds but ships without the runner, so
Runner-based agents cannot start. Before each install, `deploy.sh` therefore:

1. reads the Rust version from `packages/paperclip-runner/rust-toolchain.toml`
   in the checkout being deployed (no pin, no runner build);
2. installs `rustup` into `~/.rustup` and `~/.cargo` if missing, verifying the
   installer against the SHA-256 that Rust publishes beside it;
3. installs the pinned toolchain if absent and selects it with
   `RUSTUP_TOOLCHAIN` for the installer and its builds. A host that already has
   the toolchain makes no network calls.

This needs a C compiler/linker (the Xcode command line tools) and outbound
HTTPS to `static.rust-lang.org`. It does not edit shell profiles. After the
install it logs whether the payload contains `paperclip-runnerd`.

`PAPERCLIP_DEPLOY_BUILD_RUNNER` (`build_runner` in the private JSON) controls it:

- `auto` (default): provision the toolchain; if that fails, log a warning and
  deploy without the runner.
- `require`: a missing toolchain parks the deploy until the next push, and the
  build fails instead of skipping the runner.
- `off`: never touch Rust.

The first compile is CPU-heavy. Use `build_when: "idle"` to run it in a quiet
window. A new or rebuilt daemon binary is scanned on first launch, so add it
to any prelaunch warm-up your host uses.

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

Git-ref installs print `[git install] <stage>: <seconds>s` to stdout. The build
uses the checkout's pnpm lockfile and copies its installed production graph
without packing tarballs or running a second npm install. The payload retains
`node_modules/paperclipai/dist/index.js` and `node_modules/@paperclipai/server`,
including the server UI, skills, Runner, and migration assets. Dependency scripts
run during the source install; deployment reuses those host-specific, patched
packages without running the scripts again. Files use copy-on-write clones where
the filesystem supports them. The copier follows installed dependency and peer
links, keeps workspace builds, and applies their published entrypoint metadata.
It does not resolve package ranges. The internal dependency store stays under
the server package so provider integrity checks keep their existing boundary.
Generated provider assets include their nested runtime dependency directories. pnpm 9 deploy still resolves ranges for the
CLI bundle's additional external imports, so it cannot provide this guarantee. Payload links are checked before
activation so deleting the source checkout cannot break the installed service.

Git builds keep dependency directories in a private per-repository workspace under
`$PAPERCLIP_HOME/cli/build/`. Each install removes all source and generated files
before extracting the requested commit. It retains only the root `node_modules`
directory, including pnpm's virtual store. pnpm recreates workspace-local links.
Nested `node_modules` inside generated provider assets are removed with those
assets, so the next build can materialize a complete verified closure. It never reuses `dist`, UI output,
or TypeScript build state. Dependency installation runs noninteractively, including module recreation when
pnpm detects a configuration change. A per-repository lock also protects direct build
callers; managed install/update activation keeps its existing store lock.

Set `PAPERCLIP_GIT_INSTALL_CLEAN=1` for a fresh build workspace. This applies only
to git builds; an already installed SHA still uses its verified cached payload.
A failed or interrupted build marks its workspace dirty. The next attempt uses a
new directory, so an orphaned compiler cannot write into that attempt. Dirty
`work-*` generations remain quarantined under the repository build folder. After
a successful build, while holding the build lock, the installer removes other
generations with a directory mtime older than 24 hours. It keeps the current
generation and recent failures. A forced clean build
replaces a previously successful workspace. Runtime/architecture changes also
start a fresh workspace. Published npm installs are unaffected.

Keep pnpm store settings stable across builds. If you customize `store-dir`, use
the operator home's `.npmrc` so nested build commands use the same setting.
