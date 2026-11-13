// Tests the Rust toolchain helpers in deploy.sh against a fake rustup served
// from a local file:// URL. Nothing is downloaded and no real toolchain is
// installed. Run with: node --test deploy/macos/deploy.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const deployScript = readFileSync(path.join(here, "deploy.sh"), "utf8");

// The helpers sit between install_rustup() and the script's main flow; log()
// is defined earlier. Sourcing deploy.sh itself would run a deploy.
function helperSource() {
  const log = deployScript.match(/^log\(\) .*$/m)?.[0];
  const start = deployScript.indexOf("install_rustup() {");
  const end = deployScript.indexOf('\ncd "$REPO_ROOT"');
  assert.ok(log && start > 0 && end > start, "deploy.sh helper markers moved");
  return `${log}\n${deployScript.slice(start, end)}`;
}

const FAKE_RUSTUP_INIT = `#!/bin/sh
echo run >> "$HOME/init-count"
mkdir -p "$CARGO_HOME/bin"
cat > "$CARGO_HOME/bin/rustup" <<'R'
#!/bin/sh
case "$1 $2" in
  "toolchain list") [ -f "$CARGO_HOME/tc" ] && cat "$CARGO_HOME/tc" ;;
  "toolchain install") echo "$3-x86_64-apple-darwin (default)" > "$CARGO_HOME/tc" ;;
esac
R
printf '#!/bin/sh\\necho "cargo fake $RUSTUP_TOOLCHAIN"\\n' > "$CARGO_HOME/bin/cargo"
printf '#!/bin/sh\\necho "rustc fake"\\n' > "$CARGO_HOME/bin/rustc"
chmod +x "$CARGO_HOME/bin/"*
`;

function fixture({ pin = '[toolchain]\nchannel = "1.97.1"\n', digest = "match" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "deploy-test-"));
  for (const triple of ["x86_64-apple-darwin", "aarch64-apple-darwin"]) {
    const dir = path.join(root, "dist", triple);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "rustup-init"), FAKE_RUSTUP_INIT);
    chmodSync(path.join(dir, "rustup-init"), 0o755);
    const sum = digest === "match"
      ? createHash("sha256").update(FAKE_RUSTUP_INIT).digest("hex")
      : "0".repeat(64);
    // Rust publishes "<hash> *./rustup-init".
    writeFileSync(path.join(dir, "rustup-init.sha256"), `${sum} *./rustup-init\n`);
  }
  const toolchainFile = path.join(root, "rust-toolchain.toml");
  if (pin !== null) writeFileSync(toolchainFile, pin);
  mkdirSync(path.join(root, "home"));
  return { root, toolchainFile };
}

function runBash(root, toolchainFile, body) {
  const script = `
set -euo pipefail
export HOME="${root}/home" RUSTUP_HOME="${root}/home/.rustup" CARGO_HOME="${root}/home/.cargo"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
RUSTUP_DIST="file://${root}/dist"
RUNNER_TOOLCHAIN_FILE="${toolchainFile}"
PAPERCLIP_HOME="${root}/ph"
${helperSource()}
${body}
`;
  return spawnSync("bash", ["-c", script], { encoding: "utf8" });
}

test("installs rustup and the pinned toolchain, then reuses them offline", () => {
  const { root, toolchainFile } = fixture();
  try {
    const result = runBash(root, toolchainFile, `
ensure_runner_toolchain
echo "toolchain=$RUSTUP_TOOLCHAIN"
ensure_runner_toolchain
`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /toolchain=1\.97\.1/);
    assert.match(result.stdout, /runner toolchain: cargo fake 1\.97\.1/);
    // rustup-init ran exactly once across both calls.
    assert.equal(readFileSync(path.join(root, "home", "init-count"), "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a rustup installer whose checksum does not match", () => {
  const { root, toolchainFile } = fixture({ digest: "mismatch" });
  try {
    const result = runBash(root, toolchainFile, "ensure_runner_toolchain");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /checksum mismatch/);
    assert.throws(() => readFileSync(path.join(root, "home", "init-count")), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does nothing when the checkout pins no toolchain", () => {
  const { root, toolchainFile } = fixture({ pin: null });
  try {
    const result = runBash(root, toolchainFile, "ensure_runner_toolchain");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /not required/);
    assert.throws(() => readFileSync(path.join(root, "home", "init-count")), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when the pin has no readable channel", () => {
  const { root, toolchainFile } = fixture({ pin: "[toolchain]\nprofile = \"minimal\"\n" });
  try {
    const result = runBash(root, toolchainFile, "ensure_runner_toolchain");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /cannot read the toolchain channel/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner_binary_present reports the daemon, a missing daemon, and the skipped marker", () => {
  const { root, toolchainFile } = fixture();
  const bin = path.join(root, "ph/cli/current/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/bin");
  const state = (extra = "") => runBash(root, toolchainFile, `${extra}\nif runner_binary_present; then echo present; else echo absent; fi`).stdout.trim();
  try {
    assert.equal(state(), "absent");
    mkdirSync(path.join(bin, "darwin-x64"), { recursive: true });
    writeFileSync(path.join(bin, "darwin-x64", "paperclip-runnerd"), "");
    assert.equal(state(), "present");
    writeFileSync(path.join(bin, ".paperclip-runnerd-skipped"), "cargo is not available\n");
    assert.equal(state(), "absent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
