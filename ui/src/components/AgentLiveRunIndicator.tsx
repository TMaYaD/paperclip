import { Link } from "@/lib/router";
import { agentLiveRunLabel, type AgentLiveRunSummary } from "../lib/agent-live-runs";
import { cn } from "../lib/utils";

export function AgentLiveRunIndicator({
  agentRef,
  summary,
}: {
  agentRef: string;
  summary: AgentLiveRunSummary;
}) {
  const isRunning = summary.runningCount > 0;
  const label = agentLiveRunLabel(summary);
  return (
    <Link
      to={`/agents/${agentRef}/runs/${summary.runId}`}
      className={cn(
        "flex items-center gap-1.5 px-2 py-0.5 rounded-full transition-colors no-underline",
        isRunning ? "bg-blue-500/10 hover:bg-blue-500/20" : "bg-muted hover:bg-accent",
      )}
      title={
        isRunning
          ? `${summary.runningCount} running, ${summary.queuedCount} queued`
          : `${summary.queuedCount} queued, waiting for a free run slot`
      }
      onClick={(e) => e.stopPropagation()}
    >
      {isRunning ? (
        <span className="relative flex h-2 w-2">
          <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
        </span>
      ) : (
        <span className="inline-flex rounded-full h-2 w-2 bg-muted-foreground/50" />
      )}
      <span
        className={cn(
          "text-(length:--text-micro) font-medium",
          isRunning ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
    </Link>
  );
}
