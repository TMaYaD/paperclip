import type { ProviderQuotaResult } from "@paperclipai/shared";
import { listServerAdapters } from "../adapters/registry.js";

const QUOTA_PROVIDER_TIMEOUT_MS = 20_000;

/**
 * How long a provider quota snapshot stays fresh for enforcement reads.
 * Provider usage endpoints are rate limited, and the Claude CLI fallback runs a
 * multi-second terminal probe, so enforcement never fetches on every dispatch.
 */
export const QUOTA_SNAPSHOT_TTL_MS = readPositiveIntEnv("PAPERCLIP_QUOTA_SNAPSHOT_TTL_MS", 60_000);

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function providerSlugForAdapterType(type: string): string {
  switch (type) {
    case "claude_local":
      return "anthropic";
    case "codex_local":
      return "openai";
    default:
      return type;
  }
}

/**
 * Asks each registered adapter for its provider quota windows and aggregates the results.
 * Adapters that don't implement getQuotaWindows() are silently skipped.
 * Individual adapter failures are caught and returned as error results rather than
 * letting one provider's outage block the entire response.
 */
export async function fetchAllQuotaWindows(): Promise<ProviderQuotaResult[]> {
  const adapters = listServerAdapters().filter((a) => a.getQuotaWindows != null);

  const settled = await Promise.allSettled(
    adapters.map((adapter) => withQuotaTimeout(adapter.type, adapter.getQuotaWindows!())),
  );

  return settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    const adapterType = adapters[i]!.type;
    return {
      provider: providerSlugForAdapterType(adapterType),
      ok: false,
      error: String(result.reason),
      windows: [],
    };
  });
}

export type QuotaSnapshot = {
  results: ProviderQuotaResult[];
  fetchedAt: Date;
};

export type QuotaSnapshotReader = (input?: { now?: Date }) => Promise<QuotaSnapshot>;

/**
 * Builds a memoized reader over `fetchAllQuotaWindows`. One fetch is shared by
 * all concurrent callers, and the result is reused until `ttlMs` has elapsed.
 * The reader never throws: a failed fetch yields per-provider `ok: false` rows,
 * which enforcement treats as "unknown" (fail open) rather than as a block.
 */
export function createQuotaSnapshotReader(options: {
  fetch?: () => Promise<ProviderQuotaResult[]>;
  ttlMs?: number;
} = {}): QuotaSnapshotReader {
  const fetch = options.fetch ?? fetchAllQuotaWindows;
  const ttlMs = options.ttlMs ?? QUOTA_SNAPSHOT_TTL_MS;
  let cached: QuotaSnapshot | null = null;
  let inFlight: Promise<QuotaSnapshot> | null = null;

  return async (input = {}) => {
    const now = input.now ?? new Date();
    if (cached && now.getTime() - cached.fetchedAt.getTime() < ttlMs) return cached;
    if (inFlight) return inFlight;
    inFlight = fetch()
      .then((results) => ({ results, fetchedAt: new Date() }))
      .catch((error: unknown) => ({
        results: [{ provider: "unknown", ok: false, error: String(error), windows: [] }],
        fetchedAt: new Date(),
      }))
      .then((snapshot) => {
        cached = snapshot;
        return snapshot;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

let sharedQuotaSnapshotReader: QuotaSnapshotReader | null = null;

/** Process-wide memoized quota reader used by budget enforcement and summaries. */
export function readQuotaSnapshot(input?: { now?: Date }): Promise<QuotaSnapshot> {
  sharedQuotaSnapshotReader ??= createQuotaSnapshotReader();
  return sharedQuotaSnapshotReader(input);
}

async function withQuotaTimeout(
  adapterType: string,
  task: Promise<ProviderQuotaResult>,
): Promise<ProviderQuotaResult> {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<ProviderQuotaResult>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            provider: providerSlugForAdapterType(adapterType),
            ok: false,
            error: `quota polling timed out after ${Math.round(QUOTA_PROVIDER_TIMEOUT_MS / 1000)}s`,
            windows: [],
          });
        }, QUOTA_PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
