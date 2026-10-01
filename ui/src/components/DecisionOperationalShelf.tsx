import { useState } from "react";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import { attentionRepairAgentId } from "../lib/attention";
import { AttentionQueueRow } from "./AttentionQueueRow";
import { Curtain } from "./DecisionShelf";
import { Button } from "./ui/button";

/** Preserve operational alerts and their native actions outside the decision list. */
export function DecisionOperationalShelf({
  items, kind, companyId, agentMap, agents, currentUserId,
  expandedId, onToggleExpand, onDismiss, onSnooze,
}: {
  items: AttentionItem[];
  kind: "repair" | "waiting";
  companyId: string;
  agentMap: Map<string, Agent>;
  agents: Agent[] | undefined;
  currentUserId: string | null;
  expandedId: string | null;
  onToggleExpand: (item: AttentionItem) => void;
  onDismiss: (item: AttentionItem) => void;
  onSnooze: (item: AttentionItem, until: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(50);
  if (items.length === 0) return null;
  const groups = new Map<string, AttentionItem[]>();
  for (const item of items) {
    const key = kind === "repair" ? attentionRepairAgentId(item) ?? "other" : "waiting";
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  let remaining = limit;
  return (
    <Curtain label={kind === "repair" ? "Needs repair" : "Waiting"} count={items.length} open={open} onToggle={() => setOpen((value) => !value)}>
      <p className="text-xs text-muted-foreground">
        {kind === "repair"
          ? "Work has stopped or needs an operational repair. Inspect the cause before retrying or changing its owner."
          : "Work has a recorded waiting owner or belongs to a parked project. Its next action is shown on the task."}
      </p>
      {[...groups].map(([key, group]) => {
        const rows = group.slice(0, remaining);
        remaining -= rows.length;
        if (rows.length === 0) return null;
        return (
          <div key={key} className="space-y-4">
            {key !== "other" && kind === "repair" && (
              <p className="text-sm font-medium">{agentMap.get(key)?.name ?? "Agent"} — {group.length} related {group.length === 1 ? "alert" : "alerts"}</p>
            )}
            {rows.map((item) => (
              <AttentionQueueRow key={item.id} item={item} companyId={companyId}
                expanded={expandedId === item.id} onToggleExpand={onToggleExpand}
                onDismiss={onDismiss} onSnooze={onSnooze} agentMap={agentMap}
                agents={agents} currentUserId={currentUserId} showTriage />
            ))}
          </div>
        );
      })}
      {items.length > limit && <Button variant="outline" size="sm" onClick={() => setLimit((value) => value + 50)}>Show more alerts</Button>}
    </Curtain>
  );
}
