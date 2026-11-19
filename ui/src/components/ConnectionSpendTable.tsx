import { BUDGET_CONNECTION_FILTER_UNMANAGED, type CostByConnection } from "@paperclipai/shared";
import { formatCents, formatTokens, providerDisplayName } from "@/lib/utils";

export const UNMANAGED_CONNECTION_LABEL = "Existing authentication — not managed by Connections";

/** Display name for a connection spend row or a budget connection filter. */
export function connectionLabel(input: { connectionId: string | null; connectionName?: string | null }) {
  if (!input.connectionId || input.connectionId === BUDGET_CONNECTION_FILTER_UNMANAGED) return UNMANAGED_CONNECTION_LABEL;
  return input.connectionName ?? "Removed connection";
}

/** Spend per AI Connection for the selected range. */
export function ConnectionSpendTable({ rows }: { rows: CostByConnection[] }) {
  const visible = rows.filter((row) => row.eventCount > 0 || row.connectionId !== null);
  return (
    <section className="space-y-3" aria-label="Spend by connection">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Spend by connection</h2>
        <p className="text-sm text-muted-foreground">
          Usage grouped by the AI connection each run used. Agents on the same provider but different connections, such as an Anthropic subscription and an Anthropic-compatible gateway, are listed separately.
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border border-border" role="table" aria-label="Connection spend">
        <div role="row" className="hidden grid-cols-12 gap-6 border-b border-border bg-muted/30 px-5 py-3 text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground md:grid">
          <div role="columnheader" className="col-span-5">Connection</div>
          <div role="columnheader" className="col-span-2 text-right">Spend</div>
          <div role="columnheader" className="col-span-3 text-right">Tokens in / out</div>
          <div role="columnheader" className="col-span-2 text-right">Agents · events</div>
        </div>
        <div role="rowgroup" className="divide-y divide-border">
          {visible.map((row) => (
            <div role="row" key={row.connectionId ?? BUDGET_CONNECTION_FILTER_UNMANAGED} className="grid grid-cols-1 gap-2 bg-card px-5 py-4 md:grid-cols-12 md:items-center md:gap-6">
              <div role="cell" className="space-y-1 md:col-span-5">
                <div className="font-medium">{connectionLabel(row)}</div>
                <div className="text-xs text-muted-foreground">
                  {row.provider ? providerDisplayName(row.provider) : "Mixed providers"}
                  {!row.connectionExists ? " · connection removed" : ""}
                </div>
              </div>
              <div role="cell" className="font-mono tabular-nums md:col-span-2 md:text-right">
                {formatCents(row.costCents)}
                {row.unpricedEventCount > 0 ? <div className="text-xs text-muted-foreground">{row.unpricedEventCount} unpriced</div> : null}
              </div>
              <div role="cell" className="font-mono text-sm tabular-nums text-muted-foreground md:col-span-3 md:text-right">
                {formatTokens(row.inputTokens + row.cachedInputTokens)} / {formatTokens(row.outputTokens)}
              </div>
              <div role="cell" className="text-sm tabular-nums text-muted-foreground md:col-span-2 md:text-right">
                {row.agentCount} · {row.eventCount}
              </div>
            </div>
          ))}
          {visible.length === 0 ? (
            <div role="row"><div role="cell" className="px-5 py-8 text-sm text-muted-foreground">No AI connections or usage in this period.</div></div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
