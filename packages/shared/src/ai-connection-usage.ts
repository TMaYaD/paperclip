import type { AiAuthMethod, AiProvider } from "./ai-connections.js";

/** A provider observation, never an estimate from Paperclip's run costs. */
export interface AiConnectionUsageLimit {
  id: string;
  label: string;
  /** Null means the account-wide allowance; named model/features stay separate. */
  scope: string | null;
  windowDurationSeconds: number | null;
  /** Provider-named reset cadence when no exact duration is available. */
  resetInterval?: string | null;
  resetsAt: string | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  unit: string | null;
  limitReached: boolean | null;
  /** Only set when the provider reports admission explicitly. */
  allowed: boolean | null;
}

export interface AiConnectionUsageOverage {
  enabled: boolean | null;
  /** Null when enabling overage does not prove a funded usable balance. */
  available: boolean | null;
  unlimited: boolean | null;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  balance: number | null;
  unit: string | null;
}

export interface AiConnectionUsage {
  connectionId: string;
  grantId: string;
  provider: AiProvider;
  method: AiAuthMethod;
  status: "ok" | "unsupported" | "unavailable" | "error";
  checkedAt: string;
  source: string | null;
  planType: string | null;
  limits: AiConnectionUsageLimit[];
  overage: AiConnectionUsageOverage | null;
  errorCode?: "unsupported" | "connection_unavailable" | "authentication_required" | "permission_denied" | "rate_limited" | "provider_unavailable" | "invalid_response";
  message?: string;
}

/**
 * Anthropic- and OpenAI-compatible gateways whose plan usage Paperclip can
 * read. A connection routed to one of these hosts uses that gateway's usage
 * probe with the same key it uses for inference, whatever its sign-in method.
 * Add a gateway here and give it a probe on the server to make its limits
 * available to usage panels and subscription budget rules.
 */
export const AI_GATEWAY_USAGE_PROBES = [
  { id: "minimax", name: "MiniMax", domains: ["minimax.io", "minimaxi.com"] },
  { id: "zai", name: "Z.ai", domains: ["z.ai", "bigmodel.cn"] },
  { id: "kimi", name: "Kimi", domains: ["kimi.com"] },
] as const;
export type AiGatewayUsageProbeId = (typeof AI_GATEWAY_USAGE_PROBES)[number]["id"];

/** The gateway usage probe for a connection's routed base URL, or null. */
export function aiGatewayUsageProbe(routing: { baseUrl?: string | null } | null | undefined): { id: AiGatewayUsageProbeId; domain: string; host: string } | null {
  if (!routing?.baseUrl) return null;
  let host: string;
  try { host = new URL(routing.baseUrl).hostname.toLowerCase(); } catch { return null; }
  for (const probe of AI_GATEWAY_USAGE_PROBES) {
    const domain = probe.domains.find((candidate) => host === candidate || host.endsWith(`.${candidate}`));
    if (domain) return { id: probe.id, domain, host };
  }
  return null;
}

export function supportsAiConnectionUsage(provider: AiProvider, method: AiAuthMethod, routing?: { baseUrl?: string | null } | null): boolean {
  if (aiGatewayUsageProbe(routing)) return true;
  // Another gateway's key is not a provider subscription credential.
  if (routing?.baseUrl) return false;
  return method === "subscription"
    ? provider === "openai" || provider === "anthropic" || provider === "xai"
    : provider === "openrouter";
}
