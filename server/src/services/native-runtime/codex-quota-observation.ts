import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";

type Observation = Parameters<NonNullable<AdapterExecutionContext["onProviderQuotaObserved"]>>[0];

/** Read only the runner's allowlisted quota diagnostic, preserving replay age. */
export function nativeCodexQuotaObservation(
  providerKind: string,
  event: Pick<PrpEvent, "sourceKind" | "eventType" | "payload" | "emittedAt">,
): Observation | null {
  if (providerKind !== "codex" || event.sourceKind !== "runner" || event.eventType !== "harness.diagnostic") return null;
  const payload = event.payload;
  if (payload.code !== "codex_quota_updated" || !payload.rateLimits || typeof payload.rateLimits !== "object" || Array.isArray(payload.rateLimits)) return null;
  return { kind: "codex_rate_limits", info: payload.rateLimits as Record<string, unknown>, observedAt: event.emittedAt };
}
