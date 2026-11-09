import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  buildIssueChildReadyForAssignmentWake,
  buildIssueChildReadyForAssignmentWakeStateKey,
  findExistingIssueChildReadyForAssignmentWakeForReadyState,
} from "../services/issue-dependency-wakeups.js";

const readyState = {
  companyId: "company-a",
  parentIssueId: "parent-a",
  childIssueId: "child-a",
  blockerIssueIds: ["blocker-b", "blocker-a"],
  blockedTransitionAt: new Date("2026-11-09T12:00:00.000Z"),
};

function dbWithWakeRows(rows: Array<{ id: string; status: string; idempotencyKey: string }>): Db {
  return {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
  } as unknown as Db;
}

describe("child ready for assignment wake", () => {
  it("targets the parent and carries the ready child and blocker context", () => {
    const wake = buildIssueChildReadyForAssignmentWake({
      ...readyState,
      parentAssigneeAgentId: "agent-a",
      resolvedBlockerIssueId: "blocker-a",
      source: "issue.blocker_done",
      mutation: "blocker_done",
    });
    expect(wake).toMatchObject({
      agentId: "agent-a",
      source: "automation",
      triggerDetail: "system",
      reason: "issue_child_ready_for_assignment",
      idempotencyKey: buildIssueChildReadyForAssignmentWakeStateKey(readyState),
      payload: { issueId: "parent-a", readyChildIssueId: "child-a", blockerIssueIds: ["blocker-a", "blocker-b"], resolvedBlockerIssueId: "blocker-a", mutation: "blocker_done" },
      contextSnapshot: { issueId: "parent-a", taskId: "parent-a", readyChildIssueId: "child-a", source: "issue.blocker_done" },
    });
  });
  it("keys the parent, child, complete blocker set, and child's blocked cycle", () => {
    const key = buildIssueChildReadyForAssignmentWakeStateKey(readyState);
    expect(key).toMatch(/^issue_child_ready_for_assignment:state:parent-a:child-a:2:[a-f0-9]{32}$/);
    expect(buildIssueChildReadyForAssignmentWakeStateKey({ ...readyState, blockerIssueIds: ["blocker-a", "blocker-b", "blocker-a"] })).toBe(key);
    expect(buildIssueChildReadyForAssignmentWakeStateKey({ ...readyState, parentIssueId: "parent-b" })).not.toBe(key);
    expect(buildIssueChildReadyForAssignmentWakeStateKey({ ...readyState, childIssueId: "child-b" })).not.toBe(key);
    expect(buildIssueChildReadyForAssignmentWakeStateKey({ ...readyState, blockerIssueIds: ["blocker-a"] })).not.toBe(key);
    expect(buildIssueChildReadyForAssignmentWakeStateKey({ ...readyState, blockedTransitionAt: new Date("2026-11-09T12:01:00.000Z") })).not.toBe(key);
  });

  it.each(["queued", "deferred_issue_execution", "claimed", "completed", "coalesced"])(
    "deduplicates a %s wake for the current state",
    async (status) => {
      const idempotencyKey = buildIssueChildReadyForAssignmentWakeStateKey(readyState);
      const wake = { id: "wake-a", status, idempotencyKey };
      expect(await findExistingIssueChildReadyForAssignmentWakeForReadyState(dbWithWakeRows([wake]), readyState)).toEqual(wake);
    },
  );

  it.each(["skipped", "failed", "cancelled"])(
    "permits another wake after a %s receipt",
    async (status) => {
      const idempotencyKey = buildIssueChildReadyForAssignmentWakeStateKey(readyState);
      expect(await findExistingIssueChildReadyForAssignmentWakeForReadyState(
        dbWithWakeRows([{ id: "wake-a", status, idempotencyKey }]), readyState,
      )).toBeNull();
    },
  );
});
