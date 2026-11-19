import type { AdapterBillingType } from "@paperclipai/adapter-utils";

/**
 * Gateways that speak the Anthropic Messages API but bill on their own
 * account. Matched on the base URL host or a parent domain.
 */
const ANTHROPIC_COMPATIBLE_BILLERS: ReadonlyArray<readonly [domain: string, biller: string]> = [
  ["minimax.io", "minimax"],
  ["minimaxi.com", "minimax"],
  ["openrouter.ai", "openrouter"],
];

function hostMatches(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * The biller for a Claude CLI base URL when it is a known Anthropic-compatible
 * gateway with its own billing, or null otherwise. An unrecognised base URL is
 * most often a proxy in front of Anthropic (a team gateway, a cluster egress
 * proxy), so it keeps Anthropic billing; spend through it is still separated
 * by AI Connection where one is used.
 */
export function claudeBaseUrlBiller(baseUrl: string | null | undefined): string | null {
  const value = baseUrl?.trim();
  if (!value) return null;
  let hostname: string;
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [domain, biller] of ANTHROPIC_COMPATIBLE_BILLERS) {
    if (hostMatches(hostname, domain)) return biller;
  }
  return null;
}

export type ClaudeBillingIdentity = { provider: "anthropic"; biller: string; billingType: AdapterBillingType };

/**
 * Billing identity for a Claude Code run, read from its effective env.
 * Bedrock and known Anthropic-compatible gateways are metered on their own
 * account and never use the Claude subscription, whatever key variable the
 * gateway token is passed in. Otherwise an API key means API billing and no
 * key means the Claude subscription.
 */
export function resolveClaudeBillingIdentity(readEnv: (key: string) => string | undefined): ClaudeBillingIdentity {
  const has = (key: string) => Boolean(readEnv(key)?.trim());
  const bedrockFlag = readEnv("CLAUDE_CODE_USE_BEDROCK")?.trim();
  if (bedrockFlag === "1" || bedrockFlag === "true" || has("ANTHROPIC_BEDROCK_BASE_URL")) {
    return { provider: "anthropic", biller: "aws_bedrock", billingType: "metered_api" };
  }
  const gateway = claudeBaseUrlBiller(readEnv("ANTHROPIC_BASE_URL"));
  if (gateway) return { provider: "anthropic", biller: gateway, billingType: "metered_api" };
  return { provider: "anthropic", biller: "anthropic", billingType: has("ANTHROPIC_API_KEY") ? "api" : "subscription" };
}
