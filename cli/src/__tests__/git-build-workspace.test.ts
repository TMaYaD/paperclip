import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gitBuildWorkspaceRoot, withGitBuildWorkspace } from "../git-build-workspace.js";
import { resolveInstallStorePaths, type InstallStorePaths } from "../install-store.js";

let root: string;
let paths: InstallStorePaths;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-build-workspace-")));
  paths = resolveInstallStorePaths({ paperclipHome: path.join(root, "data"), homeDir: path.join(root, "home") });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
const write = (file: string, value = "old") => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };

it("keeps dependency inodes but removes deleted sources, outputs, build state and source symlinks", async () => {
  let previous = "";
  let inode = 0;
  await withGitBuildWorkspace("owner/repo", paths, async source => {
    previous = source;
    for (const file of ["src/deleted.ts", "dist/deleted.js", "ui/dist/index.html", "server/dist/old.js", "packages/renamed/dist/old.js", "tsconfig.tsbuildinfo"]) write(path.join(source, file));
    write(path.join(source, "node_modules/.pnpm/pkg/index.js"), "dependency");
    write(path.join(source, "server/node_modules/pkg/index.js"), "workspace-local link tree");
    write(path.join(source, "server/provider-assets/copilot/host/distribution/node_modules/vendor/index.js"), "generated asset");
    inode = fs.statSync(path.join(source, "node_modules/.pnpm/pkg/index.js")).ino;
    fs.symlinkSync("dist", path.join(source, "linked-output"));
  });
  await withGitBuildWorkspace("owner/repo", paths, async source => {
    expect(source).toBe(previous);
    expect(fs.statSync(path.join(source, "node_modules/.pnpm/pkg/index.js")).ino).toBe(inode);
    expect(fs.existsSync(path.join(source, "server"))).toBe(false);
    expect(fs.readdirSync(source)).toEqual(["node_modules"]);
  });
});

it("serializes concurrent direct callers and releases the lock after a failure", async () => {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const pending = withGitBuildWorkspace("owner/repo", paths, async () => {
    entered(); await new Promise<void>(resolve => { release = resolve; }); throw new Error("build failed");
  });
  await ready;
  await expect(withGitBuildWorkspace("owner/repo", paths, async () => undefined)).rejects.toThrow("already running");
  release();
  await expect(pending).rejects.toThrow("build failed");
  await withGitBuildWorkspace("owner/repo", paths, async () => undefined);
});

it("quarantines failed generations so late writes cannot poison the next build", async () => {
  let failed = "";
  await expect(withGitBuildWorkspace("owner/repo", paths, async source => {
    failed = source; write(path.join(source, "node_modules/poison")); throw new Error("failed install");
  })).rejects.toThrow("failed install");
  await withGitBuildWorkspace("owner/repo", paths, async source => {
    expect(source).not.toBe(failed);
    write(path.join(failed, "dist/late-compiler-output.js"));
    expect(fs.readdirSync(source)).toEqual([]);
  });
});

it("recovers a real process exit and stale lock using a different absolute directory", async () => {
  const helper = new URL("../git-build-workspace.ts", import.meta.url).href;
  const code = `import fs from 'node:fs'; import {withGitBuildWorkspace} from ${JSON.stringify(helper)};
    await withGitBuildWorkspace('owner/repo', ${JSON.stringify(paths)}, async source => {
      fs.writeFileSync(${JSON.stringify(path.join(root, "interrupted-source"))}, source);
      process.exit(71);
    });`;
  const child = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", code], { encoding: "utf8" });
  expect(child.status, child.stderr).toBe(71);
  const interrupted = fs.readFileSync(path.join(root, "interrupted-source"), "utf8");
  await withGitBuildWorkspace("owner/repo", paths, async source => { expect(source).not.toBe(interrupted); });
});

it("isolates repository identities, tolerates a corrupt marker, and supports forced clean builds", async () => {
  expect(gitBuildWorkspaceRoot("a-b/c", paths)).not.toBe(gitBuildWorkspaceRoot("a/b-c", paths));
  let previous = "";
  await withGitBuildWorkspace("owner/repo", paths, async source => { previous = source; write(path.join(source, "node_modules/kept")); });
  vi.stubEnv("PAPERCLIP_GIT_INSTALL_CLEAN", "1");
  await withGitBuildWorkspace("owner/repo", paths, async source => { expect(source).not.toBe(previous); expect(fs.readdirSync(source)).toEqual([]); });
  vi.unstubAllEnvs();
  fs.writeFileSync(path.join(gitBuildWorkspaceRoot("owner/repo", paths), "state.json"), "interrupted JSON");
  await withGitBuildWorkspace("owner/repo", paths, async source => { expect(fs.readdirSync(source)).toEqual([]); });
});

it("refuses a symlinked workspace root", async () => {
  const target = path.join(root, "outside"); fs.mkdirSync(target);
  fs.mkdirSync(paths.cliRoot, { recursive: true });
  fs.symlinkSync(target, path.join(paths.cliRoot, "build"));
  await expect(withGitBuildWorkspace("owner/repo", paths, async () => undefined)).rejects.toThrow("unsafe git build workspace");
  expect(fs.readdirSync(target)).toEqual([]);
});
