// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionOperationalShelf } from "./DecisionOperationalShelf";

vi.mock("./AttentionQueueRow", () => ({ AttentionQueueRow: ({ item }: { item: AttentionItem }) => <div>{item.subject.title}</div> }));

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  flushSync(() => root?.unmount());
  container?.remove();
});

function item(id: string, agentId: string): AttentionItem {
  return { id, sourceKind: "blocker_attention", subject: { id, title: id }, detail: { kind: "blocker", repairAgentId: agentId } } as AttentionItem;
}

function render(items: AttentionItem[], kind: "repair" | "waiting") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(<DecisionOperationalShelf items={items} kind={kind} companyId="company"
    agentMap={new Map([["reviewer", { name: "Reviewer" } as Agent]])} agents={[]} currentUserId="user" expandedId={null}
    onToggleExpand={() => {}} onDismiss={() => {}} onSnooze={() => {}} />));
  return container;
}

describe("operational shelves", () => {
  it("shows repair counts while collapsed and groups related failures when opened", () => {
    const el = render([item("review-1", "reviewer"), item("review-2", "reviewer")], "repair");
    expect(el.textContent).toContain("Needs repair (2)");
    expect(el.textContent).not.toContain("review-1");
    flushSync(() => el.querySelector('button')!.click());
    expect(el.textContent).toContain("Reviewer — 2 related alerts");
    expect(el.textContent).toContain("review-1");
    expect(el.textContent).toContain("review-2");
  });

  it("keeps waiting work available without calling it a repair", () => {
    const el = render([item("parked-work", "reviewer")], "waiting");
    expect(el.textContent).toContain("Waiting (1)");
    flushSync(() => el.querySelector('button')!.click());
    expect(el.textContent).toContain("recorded waiting owner");
    expect(el.textContent).toContain("parked-work");
    expect(el.textContent).not.toContain("related alerts");
  });
});
