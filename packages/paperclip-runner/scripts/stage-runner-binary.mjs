import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export async function stageRunnerBinary(source, destination) {
  const destinationDirectory = path.dirname(destination);
  await mkdir(destinationDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(path.join(destinationDirectory, ".runnerd-stage-"));
  const staged = path.join(stagingDirectory, path.basename(destination));
  try {
    await copyFile(source, staged, constants.COPYFILE_EXCL);
    if (process.platform !== "win32") await chmod(staged, 0o755);
    // Sign the new inode before publication. Replacing the pathname atomically
    // preserves a running old executable instead of truncating its live inode.
    if (process.platform === "darwin") {
      await execFileAsync("codesign", ["--force", "--sign", "-", staged], { timeout: 30_000 });
      await execFileAsync("codesign", ["--verify", "--strict", staged], { timeout: 30_000 });
    }
    await rename(staged, destination);
  } finally {
    // This fresh directory is the only cleanup target, never the destination.
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

/**
 * Where cargo wrote the release executable. An installer may point
 * `CARGO_TARGET_DIR` outside the source tree so compiled crates survive
 * between builds; cargo (run from the package root by build-runner-binary.mjs)
 * resolves a relative value from there. Without it, the default target applies.
 */
export function builtRunnerBinaryPath(packageRoot, executable, env = process.env) {
  const targetDirectory = env.CARGO_TARGET_DIR?.trim();
  if (targetDirectory) return path.resolve(packageRoot, targetDirectory, "release", executable);
  return path.join(packageRoot, "runner", "target", "release", executable);
}

export async function stageBuiltRunnerBinary(packageRoot) {
  const executable = process.platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd";
  const source = builtRunnerBinaryPath(packageRoot, executable);
  const binaryRoot = path.join(packageRoot, "dist", "bin");
  await stageRunnerBinary(source, path.join(binaryRoot, executable));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await stageBuiltRunnerBinary(packageRoot);
}
