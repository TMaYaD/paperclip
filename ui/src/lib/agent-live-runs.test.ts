import { describe, expect, it } from "vitest";
import { agentLiveRunLabel, summarizeAgentLiveRuns } from "./agent-live-runs";

describe("summarizeAgentLiveRuns", () => {
  it("splits running and queued runs per agent and links to a running run", () => {
    const summary = summarizeAgentLiveRuns([
      { id: "q1", agentId: "a", status: "queued" },
      { id: "r1", agentId: "a", status: "running" },
      { id: "r2", agentId: "a", status: "running" },
      { id: "q2", agentId: "a", status: "queued" },
      { id: "q3", agentId: "b", status: "queued" },
      { id: "done", agentId: "c", status: "succeeded" },
    ]);
    expect(summary.get("a")).toEqual({ runId: "r1", runningCount: 2, queuedCount: 2 });
    expect(summary.get("b")).toEqual({ runId: "q3", runningCount: 0, queuedCount: 1 });
    expect(summary.has("c")).toBe(false);
  });
});

describe("agentLiveRunLabel", () => {
  it.each([
    [{ runningCount: 1, queuedCount: 0 }, "Live"],
    [{ runningCount: 4, queuedCount: 0 }, "Live (4)"],
    [{ runningCount: 4, queuedCount: 5 }, "Live (4) · 5 queued"],
    [{ runningCount: 0, queuedCount: 3 }, "3 queued"],
  ])("labels %o as %s", (counts, label) => {
    expect(agentLiveRunLabel({ runId: "r", ...counts })).toBe(label);
  });
});
