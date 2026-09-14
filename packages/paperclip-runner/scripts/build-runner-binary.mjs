#!/usr/bin/env node
// Build and stage the native `paperclip-runnerd` binary when a Rust toolchain
// is available.
//
// A managed `paperclipai install --ref` builds the whole workspace on the
// target host. Hosts that only run the control plane (for example a headless
// Mac with no cargo) cannot compile the runner binary, and the binary they
// would get from the npm release is a Linux ELF that cannot execute there
// anyway. Skipping the native build on such hosts keeps the vendored runner
// JavaScript (which the server does import) building and shipping.
//
// Set PAPERCLIP_RUNNER_REQUIRE_BINARY=1 to turn a missing toolchain back into
// a hard failure (release CI should do this).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cargo = process.env.CARGO?.trim() || "cargo";

const probe = spawnSync(cargo, ["--version"], { stdio: "ignore" });
if (probe.error || probe.status !== 0) {
  const message = `[paperclip-runner] ${cargo} is not available; the paperclip-runnerd native binary will not be built.`;
  if (process.env.PAPERCLIP_RUNNER_REQUIRE_BINARY === "1") {
    console.error(`${message} PAPERCLIP_RUNNER_REQUIRE_BINARY=1 makes this fatal.`);
    process.exit(1);
  }
  console.warn(`${message} Set PAPERCLIP_RUNNER_REQUIRE_BINARY=1 to fail instead.`);
  process.exit(0);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: packageRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(cargo, [
  "build",
  "--release",
  "--manifest-path",
  "runner/Cargo.toml",
  "--locked",
  "-p",
  "paperclip-runner-core",
  "--bin",
  "paperclip-runnerd",
]);
run(process.execPath, [path.join(packageRoot, "scripts", "stage-runner-binary.mjs")]);
