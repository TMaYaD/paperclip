import { z } from "zod";
import { AI_CONNECTION_CAPABILITIES, AI_PROVIDERS, type AiProvider } from "./ai-connections.js";

/**
 * A connection budget key names the account that usage ran on, for spend
 * reports and per-connection budgets:
 *
 * - an AI Connection id, for a managed connection;
 * - `local:<provider>`, for an agent with no managed binding, which runs on
 *   the host's "Local credentials" for its harness (for example the Claude
 *   Code or Codex login on the server). Each provider's local credentials are
 *   a separate account, so Claude and Codex never share a key.
 */
export const LOCAL_CONNECTION_KEY_PREFIX = "local:" as const;

export type ConnectionBudgetKey = string;

export type ParsedConnectionBudgetKey =
  | { kind: "managed"; connectionId: string }
  | { kind: "local"; provider: AiProvider };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function localConnectionKey(provider: AiProvider): ConnectionBudgetKey {
  return `${LOCAL_CONNECTION_KEY_PREFIX}${provider}`;
}

export function parseConnectionBudgetKey(key: string | null | undefined): ParsedConnectionBudgetKey | null {
  if (!key) return null;
  if (key.startsWith(LOCAL_CONNECTION_KEY_PREFIX)) {
    const provider = key.slice(LOCAL_CONNECTION_KEY_PREFIX.length);
    return (AI_PROVIDERS as readonly string[]).includes(provider) ? { kind: "local", provider: provider as AiProvider } : null;
  }
  return GUID.test(key) ? { kind: "managed", connectionId: key.toLowerCase() } : null;
}

export const connectionBudgetKeySchema = z.string().refine((value) => parseConnectionBudgetKey(value) !== null, {
  message: "Expected an AI connection id or local:<provider>",
});

/**
 * The provider whose host login a harness uses when the agent has no managed
 * AI connection. Harnesses that can reach several providers (OpenCode, Pi)
 * have no single local account and return null.
 */
export function localCredentialProviderForAdapter(adapterType: string): AiProvider | null {
  switch (adapterType) {
    case "claude_local": return "anthropic";
    case "codex_local": return "openai";
    case "gemini_local": return "google";
    case "grok_local": return "xai";
    default: return null;
  }
}

const LOCAL_HARNESS_NAMES: Partial<Record<string, string>> = { anthropic: "Claude Code", openai: "Codex", google: "Gemini CLI", xai: "Grok" };

/**
 * Board label for a provider's local credentials, named after the harness
 * whose host login they are: "Claude Code local credentials", "Codex local
 * credentials". Agents without a managed binding show as "Local credentials".
 */
export function localCredentialsLabel(provider: string): string {
  const name = LOCAL_HARNESS_NAMES[provider] ?? (AI_CONNECTION_CAPABILITIES as Record<string, { name: string } | undefined>)[provider]?.name ?? provider;
  return `${name} local credentials`;
}
