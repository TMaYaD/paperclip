import { localCredentialsLabel, parseConnectionBudgetKey, type CostByConnection } from "@paperclipai/shared";
import { formatCents, formatTokens, providerDisplayName } from "@/lib/utils";

/** Display name for a connection budget key: the connection's name, or the
 * harness's local credentials ("Claude Code local credentials"). */
export function connectionLabel(input: { connectionKey: string | null | undefined; connectionName?: string | null }) {
  const key = parseConnectionBudgetKey(input.connectionKey);
  if (key?.kind === "local") return input.connectionName ?? localCredentialsLabel(key.provider);
  return input.connectionName ?? "Removed connection";
}

/** Spend per AI Connection for the selected range. */
export function ConnectionSpendTable({ rows }: { rows: CostByConnection[] }) {
  const visible = rows;
  return (
    <section className="space-y-3" aria-label="Spend by connection">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Spend by connection</h2>
        <p className="text-sm text-muted-foreground">
          Usage grouped by the account each run used. Every AI connection is listed separately, even on the same provider; agents without a managed connection use their harness’s local credentials.
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
            <div role="row" key={row.connectionKey} className="grid grid-cols-1 gap-2 bg-card px-5 py-4 md:grid-cols-12 md:items-center md:gap-6">
              <div role="cell" className="space-y-1 md:col-span-5">
                <div className="font-medium">{connectionLabel(row)}</div>
                <div className="text-xs text-muted-foreground">
                  {row.provider ? providerDisplayName(row.provider) : "Mixed providers"}
                  {row.connectionId === null ? " · local credentials" : row.method === "subscription" ? " · subscription" : row.method === "api_key" ? " · API key" : ""}
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
