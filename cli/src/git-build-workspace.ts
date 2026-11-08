import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { withInstallStoreLock, type InstallStorePaths } from "./install-store.js";

type BuildState = {
  schemaVersion: 1;
  repo: string;
  runtime: string;
  generation: string;
  clean: boolean;
};

function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Refusing unsafe git build workspace directory ${directory}.`);
  }
  fs.chmodSync(directory, 0o700);
}

export function gitBuildWorkspaceRoot(repo: string, paths: InstallStorePaths): string {
  const identity = repo.toLowerCase();
  const label = identity.replace(/[^a-z0-9_-]/g, "-").slice(0, 80);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return path.join(paths.cliRoot, "build", `${label}-${digest}`);
}

function readState(file: string): BuildState | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return undefined;
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as BuildState;
    if (state.schemaVersion !== 1 || !/^work-[a-f0-9-]{36}$/.test(state.generation)) return undefined;
    return state;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function writeState(file: string, state: BuildState): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/** Keep only the root dependency store; nested node_modules can be generated assets. */
export function clearGitBuildSources(source: string): void {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const candidate = path.join(source, entry.name);
    if (entry.name === "node_modules" && entry.isDirectory()) continue;
    if (entry.isSymbolicLink()) fs.unlinkSync(candidate);
    else fs.rmSync(candidate, { recursive: true, force: true });
  }
}

/**
 * Serialize per-repo builds even for direct installGitPayload callers. A dirty
 * generation is never reused: an orphaned build can still hold its old cwd after
 * the installer dies. Give recovery a different absolute path instead.
 */
export async function withGitBuildWorkspace<T>(
  repo: string,
  paths: InstallStorePaths,
  build: (source: string) => Promise<T>,
): Promise<T> {
  privateDirectory(paths.cliRoot);
  privateDirectory(path.join(paths.cliRoot, "build"));
  const root = gitBuildWorkspaceRoot(repo, paths);
  privateDirectory(root);
  return withInstallStoreLock(async () => {
    const start = performance.now();
    const statePath = path.join(root, "state.json");
    const previous = readState(statePath);
    const runtime = `${process.platform}/${process.arch}/${process.versions.modules}/${process.versions.node}`;
    const reuse = process.env.PAPERCLIP_GIT_INSTALL_CLEAN !== "1"
      && previous?.clean === true && previous.repo === repo.toLowerCase() && previous.runtime === runtime
      && fs.existsSync(path.join(root, previous.generation, "source"));
    const state: BuildState = {
      schemaVersion: 1, repo: repo.toLowerCase(), runtime,
      generation: reuse ? previous.generation : `work-${randomUUID()}`, clean: false,
    };
    const generation = path.join(root, state.generation);
    privateDirectory(generation);
    const source = path.join(generation, "source");
    privateDirectory(source);
    // Commit dirty state BEFORE touching any reusable files.
    writeState(statePath, state);
    console.log(`[git install] build workspace: ${reuse ? "reuse dependencies" : "clean generation"}`);
    if (!reuse && previous?.clean === true && previous.generation !== state.generation) {
      fs.rmSync(path.join(root, previous.generation), { recursive: true, force: true });
    }
    // Recent failed generations remain isolated from possible orphaned writers.
    clearGitBuildSources(source);
    console.log(`[git install] prepare build workspace: ${((performance.now() - start) / 1000).toFixed(2)}s`);
    const result = await build(source);
    writeState(statePath, { ...state, clean: true });
    // A successful build bounds quarantine growth while this repo lock is held.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name === state.generation || !entry.name.startsWith("work-") || !entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name);
      if (fs.lstatSync(candidate).mtimeMs < cutoff) fs.rmSync(candidate, { recursive: true, force: true });
    }
    return result;
  }, { ...paths, lockPath: path.join(root, ".build.lock") }, { initialize: false });
}
