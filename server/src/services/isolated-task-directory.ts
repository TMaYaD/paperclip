import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parseObject } from "../adapters/utils.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/** A repository-free sandbox task needs isolation, but has no Git base. */
export function shouldUseIsolatedTaskDirectory(input: {
  trustPreset: string;
  environmentDriver: string | null;
  mode: string;
  hasProjectWorkspace: boolean;
  projectWorkspaceId: string | null;
  workspaceStrategies: unknown[];
}): boolean {
  return input.trustPreset === "low_trust_review"
    && input.environmentDriver === "sandbox"
    && input.mode === "isolated_workspace"
    && !input.hasProjectWorkspace
    && !input.projectWorkspaceId
    // Never discard an explicit repository/branch requirement or setup hook.
    && input.workspaceStrategies.every((value) => Object.keys(parseObject(value)).length === 0);
}

/** Stable across turns, separate from project roots and shared agent homes. */
export async function materializeIsolatedTaskDirectory(input: {
  companyId: string;
  issueId: string;
  attemptId?: string;
}): Promise<string> {
  // Files belong to the task, so reassignment preserves the same workspace.
  const identities = [input.companyId, input.issueId, ...(input.attemptId ? [input.attemptId] : [])];
  if (identities.some((value) => !/^[a-zA-Z0-9_-]+$/.test(value))) {
    throw new Error("Invalid isolated task workspace identity");
  }
  const root = resolvePaperclipInstanceRoot();
  await mkdir(root, { recursive: true });
  let cwd = await realpath(root);
  // A retry is a sibling namespace, never a descendant of the retained root.
  // An old copyback operation must not be able to overwrite its replacement.
  for (const segment of [input.attemptId ? "isolated-workspace-attempts" : "isolated-workspaces", ...identities]) {
    cwd = path.join(cwd, segment);
    await mkdir(cwd, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await lstat(cwd);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(cwd) !== cwd) {
      throw new Error("Isolated task workspace path is not a private directory");
    }
  }
  return cwd;
}

/**
 * A reused execution workspace that is this task's own repository-free directory
 * (created by a clean task-directory attempt). Such a workspace has no Git base, so
 * later turns must keep its directory transport instead of deriving `git_worktree`
 * from the isolated mode alone. Explicit strategies still win.
 */
export async function isReusedIsolatedTaskDirectory(input: {
  companyId: string;
  issueId: string | null;
  mode: string;
  reuseExisting: boolean;
  hasProjectWorkspace: boolean;
  projectWorkspaceId: string | null;
  workspaceStrategies: unknown[];
  workspace: {
    companyId: string;
    sourceIssueId: string | null;
    mode: string;
    strategyType: string;
    projectId: string | null;
    projectWorkspaceId: string | null;
    repoUrl: string | null;
    cwd: string | null;
  } | null;
}): Promise<boolean> {
  const { workspace } = input;
  if (!input.reuseExisting || !input.issueId || !workspace?.cwd) return false;
  if (input.mode !== "isolated_workspace" || input.hasProjectWorkspace || input.projectWorkspaceId) return false;
  if (!input.workspaceStrategies.every((value) => Object.keys(parseObject(value)).length === 0)) return false;
  if (workspace.companyId !== input.companyId || workspace.sourceIssueId !== input.issueId ||
      workspace.mode !== "isolated_workspace" || workspace.strategyType !== "project_primary" ||
      workspace.projectId || workspace.projectWorkspaceId || workspace.repoUrl) return false;
  // Only directories materialized for this task qualify, never an arbitrary local path.
  const root = await realpath(resolvePaperclipInstanceRoot()).catch(() => null);
  if (!root) return false;
  const cwd = path.resolve(workspace.cwd);
  const retained = path.join(root, "isolated-workspaces", input.companyId, input.issueId);
  const attempts = path.join(root, "isolated-workspace-attempts", input.companyId, input.issueId);
  return cwd === retained ||
    (path.dirname(cwd) === attempts && /^[a-zA-Z0-9_-]+$/.test(path.basename(cwd)));
}
