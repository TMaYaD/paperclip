/**
 * Per-agent split of the company live-runs feed.
 *
 * `/companies/:id/live-runs` returns both `running` and `queued` rows. Queued
 * runs are waiting for a free slot under the agent's `maxConcurrentRuns`, so
 * they must not be counted as executing work.
 */
export interface AgentLiveRunSummary {
  /** Run the indicator links to: the oldest running run, else the oldest queued run. */
  runId: string;
  runningCount: number;
  queuedCount: number;
}

interface LiveRunLike {
  id: string;
  agentId: string;
  status: string;
}

export function summarizeAgentLiveRuns(
  runs: readonly LiveRunLike[] | null | undefined,
): Map<string, AgentLiveRunSummary> {
  const map = new Map<string, AgentLiveRunSummary>();
  for (const run of runs ?? []) {
    const isRunning = run.status === "running";
    if (!isRunning && run.status !== "queued") continue;
    let summary = map.get(run.agentId);
    if (!summary) {
      summary = { runId: run.id, runningCount: 0, queuedCount: 0 };
      map.set(run.agentId, summary);
    }
    if (isRunning) {
      // Prefer linking to a run that is actually executing.
      if (summary.runningCount === 0) summary.runId = run.id;
      summary.runningCount += 1;
    } else {
      summary.queuedCount += 1;
    }
  }
  return map;
}

export function agentLiveRunLabel({ runningCount, queuedCount }: AgentLiveRunSummary): string {
  if (runningCount === 0) return `${queuedCount} queued`;
  const live = runningCount > 1 ? `Live (${runningCount})` : "Live";
  return queuedCount > 0 ? `${live} · ${queuedCount} queued` : live;
}
