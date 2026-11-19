import { describe, expect, it } from "vitest";
import { claudeBaseUrlBiller, resolveClaudeBillingIdentity } from "./billing.js";

const fromEnv = (env: Record<string, string>) => (key: string) => env[key];

describe("Claude billing identity", () => {
  it("bills MiniMax gateway usage to MiniMax, never the Claude subscription", () => {
    expect(resolveClaudeBillingIdentity(fromEnv({ ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic", ANTHROPIC_AUTH_TOKEN: "t" })))
      .toEqual({ provider: "anthropic", biller: "minimax", billingType: "metered_api" });
    expect(resolveClaudeBillingIdentity(fromEnv({ ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic", ANTHROPIC_API_KEY: "k" })).biller).toBe("minimax");
  });

  it("keeps direct Anthropic and unrecognised proxies on Anthropic billing", () => {
    expect(resolveClaudeBillingIdentity(fromEnv({}))).toEqual({ provider: "anthropic", biller: "anthropic", billingType: "subscription" });
    expect(resolveClaudeBillingIdentity(fromEnv({ ANTHROPIC_API_KEY: "k" })).billingType).toBe("api");
    expect(resolveClaudeBillingIdentity(fromEnv({ ANTHROPIC_BASE_URL: "http://gateway.internal:8080", ANTHROPIC_API_KEY: "k" })))
      .toEqual({ provider: "anthropic", biller: "anthropic", billingType: "api" });
  });

  it("keeps Bedrock first", () => {
    expect(resolveClaudeBillingIdentity(fromEnv({ CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_BASE_URL: "https://api.minimax.io" })))
      .toEqual({ provider: "anthropic", biller: "aws_bedrock", billingType: "metered_api" });
  });

  it("matches gateway hosts and their subdomains only", () => {
    expect(claudeBaseUrlBiller("https://api.minimaxi.com/anthropic")).toBe("minimax");
    expect(claudeBaseUrlBiller("https://openrouter.ai/api")).toBe("openrouter");
    expect(claudeBaseUrlBiller("https://notminimax.io")).toBeNull();
    expect(claudeBaseUrlBiller("not a url")).toBeNull();
    expect(claudeBaseUrlBiller(undefined)).toBeNull();
  });
});
