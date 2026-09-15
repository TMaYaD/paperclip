import { describe, expect, it } from "vitest";
import { parseClaudeCliResetsAt, parseClaudeCliUsageText } from "./quota.js";

// 19:30 on Sep 15 in Asia/Calcutta (UTC+5:30, no daylight time).
const NOW = new Date("2026-09-15T14:00:00.000Z");
const IST = "Asia/Calcutta";

describe("parseClaudeCliResetsAt", () => {
  it("reads a weekly reset with a date, a time and a zone", () => {
    expect(parseClaudeCliResetsAt("Resets Sep 20 at 3:30pm (Asia/Calcutta)", { now: NOW })).toBe("2026-09-20T10:00:00.000Z");
  });

  it("tolerates the lossy terminal capture: a dropped colon and a mangled zone name", () => {
    // The capture can lose characters ("3:30pm" arrives as "330pm", the zone as
    // "Asia/Clcutta"); the time still parses and the zone falls back to the
    // host's, which is the zone the CLI prints anyway.
    expect(
      parseClaudeCliResetsAt("Resets Sep 20 at 330pm (Asia/Clcutta)", { now: NOW, fallbackTimeZone: IST }),
    ).toBe("2026-09-20T10:00:00.000Z");
    expect(
      parseClaudeCliResetsAt("ResetsSep20at330pm(Asia/Clcutta)", { now: NOW, fallbackTimeZone: IST }),
    ).toBe("2026-09-20T10:00:00.000Z");
    expect(parseClaudeCliResetsAt("Resets Sep 20 at 1230pm", { now: NOW, fallbackTimeZone: "UTC" })).toBe(
      "2026-09-20T12:30:00.000Z",
    );
  });

  it("places a bare session time today, or tomorrow once it has passed", () => {
    // 1am has passed at 19:30, so the session resets at 1am tomorrow.
    expect(parseClaudeCliResetsAt("Resets 1am (Asia/Calcutta)", { now: NOW })).toBe("2026-09-15T19:30:00.000Z");
    // At 05:30, 1pm is still ahead today.
    expect(
      parseClaudeCliResetsAt("Resets 1pm (Asia/Calcutta)", { now: new Date("2026-09-15T00:00:00.000Z") }),
    ).toBe("2026-09-15T07:30:00.000Z");
  });

  it("handles the twelve o'clock edges and a date that wraps into the next year", () => {
    const midnight = new Date("2026-09-15T00:00:00.000Z");
    expect(parseClaudeCliResetsAt("Resets 12:15am (UTC)", { now: midnight })).toBe("2026-09-15T00:15:00.000Z");
    expect(parseClaudeCliResetsAt("Resets 12pm (UTC)", { now: midnight })).toBe("2026-09-15T12:00:00.000Z");
    expect(
      parseClaudeCliResetsAt("Resets Jan 2 at 9am (UTC)", { now: new Date("2026-12-30T00:00:00.000Z") }),
    ).toBe("2027-01-02T09:00:00.000Z");
    // A dated reset earlier today is left in the past rather than pushed a year out.
    expect(parseClaudeCliResetsAt("Resets Sep 15 at 9am (UTC)", { now: NOW })).toBe("2026-09-15T09:00:00.000Z");
  });

  it("converts through the printed zone's daylight time", () => {
    expect(
      parseClaudeCliResetsAt("Resets Mar 18 at 7:59am (America/Chicago)", { now: new Date("2026-03-15T12:00:00.000Z") }),
    ).toBe("2026-03-18T12:59:00.000Z");
    expect(
      parseClaudeCliResetsAt("Resets Jan 18 at 7:59am (America/Chicago)", { now: new Date("2026-01-15T12:00:00.000Z") }),
    ).toBe("2026-01-18T13:59:00.000Z");
  });

  it("returns null for text without a recognizable reset", () => {
    expect(parseClaudeCliResetsAt(null, { now: NOW })).toBeNull();
    expect(parseClaudeCliResetsAt("Extra usage not enabled • /extra-usage to enable", { now: NOW })).toBeNull();
    expect(parseClaudeCliResetsAt("Resets soon", { now: NOW })).toBeNull();
    expect(parseClaudeCliResetsAt("Resets 13pm (UTC)", { now: NOW })).toBeNull();
    expect(parseClaudeCliResetsAt("Resets Sep 40 at 3pm (UTC)", { now: NOW })).toBeNull();
  });
});

describe("parseClaudeCliUsageText reset times", () => {
  it("fills resetsAt for the session and weekly windows and leaves extra usage without one", () => {
    const raw = `
      Settings:  Status   Config   Usage
      Current session
      3% used
      Resets1am(Asia/Calcutta)

      Current week (all models)
      75% used
      Resets Sep 20 at 3:30pm (Asia/Calcutta)

      Extra usage
      Extra usage not enabled • /extra-usage to enable
    `;
    const windows = parseClaudeCliUsageText(raw, { now: NOW });
    expect(windows.map((window) => [window.key, window.resetsAt])).toEqual([
      ["five_hour", "2026-09-15T19:30:00.000Z"],
      ["seven_day", "2026-09-20T10:00:00.000Z"],
      ["extra_usage", null],
    ]);
    expect(windows[0]?.detail).toBe("Resets 1am (Asia/Calcutta)");
  });
});
