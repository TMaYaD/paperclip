import { codexQuotaObservations } from "../services/codex-quota-observations.js";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../adapters/registry.js", () => ({
  listServerAdapters: vi.fn(),
}));

import { listServerAdapters } from "../adapters/registry.js";
import { fetchAllQuotaWindows } from "../services/quota-windows.js";

describe("fetchAllQuotaWindows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("skips the Codex probe while passive data is fresh without starving Claude", async () => {
    const passive = { provider: "openai", source: "codex-run-stream", ok: true, windows: [] };
    const read = vi.spyOn(codexQuotaObservations, "read").mockResolvedValue(passive);
    const codex = vi.fn().mockResolvedValue({ ...passive, source: "codex-rpc" });
    const claude = vi.fn().mockResolvedValue({ provider: "anthropic", ok: true, windows: [] });
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "codex_local", getQuotaWindows: codex }, { type: "claude_local", getQuotaWindows: claude },
    ] as never);
    expect((await fetchAllQuotaWindows())[0]).toEqual(passive);
    expect(codex).not.toHaveBeenCalled();
    expect(claude).toHaveBeenCalledOnce();
    read.mockResolvedValue(null);
    expect((await fetchAllQuotaWindows())[0].source).toBe("codex-rpc");
    expect(codex).toHaveBeenCalledOnce();
  });

  it("returns adapter results without waiting for a slower provider to finish forever", async () => {
    vi.mocked(listServerAdapters).mockReturnValue([
      {
        type: "codex_local",
        getQuotaWindows: vi.fn().mockResolvedValue({
          provider: "openai",
          source: "codex-rpc",
          ok: true,
          windows: [{ key: "five_hour", label: "5h limit", usedPercent: 2, resetsAt: null, valueLabel: null, detail: null }],
        }),
      },
      {
        type: "claude_local",
        getQuotaWindows: vi.fn(() => new Promise(() => {})),
      },
    ] as never);

    const promise = fetchAllQuotaWindows();
    await vi.advanceTimersByTimeAsync(20_001);
    const results = await promise;

    expect(results).toEqual([
      {
        provider: "openai",
        source: "codex-rpc",
        ok: true,
        windows: [{ key: "five_hour", label: "5h limit", usedPercent: 2, resetsAt: null, valueLabel: null, detail: null }],
      },
      {
        provider: "anthropic",
        ok: false,
        error: "quota polling timed out after 20s",
        windows: [],
      },
    ]);
  });
});
