import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);

// Exercise the installed patched functions without starting a provider or
// executing a model request. These are package source, not provider input.
function functionBody(source: string, start: string, end: string) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`Patched transport function not found: ${start}`);
  return source.slice(a + start.length, b);
}

describe("installed Codex ACP quota bridge", () => {
  it.each(["direct", "runner"])("forwards notifications through ACP and ACPX (%s) without arbitrary metadata", async (lane) => {
    const codexPath = path.join(path.dirname(require.resolve("@agentclientprotocol/codex-acp/package.json")), "dist/index.js");
    const source = fs.readFileSync(codexPath, "utf8");
    const body = functionBody(source, "  async createUpdateEvent(notification) {", "\n  createCodexSessionInfoUpdate(");
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const bridge = new AsyncFunction("notification", body.slice(0, body.lastIndexOf("}")));
    const wire = await bridge.call({
      handleRateLimitsUpdated: () => {},
      createCodexSessionInfoUpdate: (codex: unknown) => ({ sessionUpdate: "session_info_update", _meta: { codex } }),
    }, { method: "account/rateLimits/updated", params: { rateLimits: {
      limitId: "codex", primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1790502487, token: "secret-marker" }, secondary: null, token: "secret-marker",
    } } });
    const runtimePath = require.resolve("@paperclipai/adapter-utils/acpx-engine/execute");
    const runtimeRequire = lane === "direct" ? createRequire(runtimePath) : createRequire(new URL("../../../../paperclip-runner/package.json", import.meta.url));
    const runtime = fs.readFileSync(runtimeRequire.resolve("acpx/runtime"), "utf8");
    const parserBody = functionBody(runtime, "function statusUpdateEvent(tag, payload) {", "\nfunction clientOperationEvent(");
    const parse = new Function("tag", "payload", "isRecord", "resolveStatusTextForTag", parserBody.slice(0, parserBody.lastIndexOf("}")));
    const event = parse("session_info_update", wire, (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v), () => null);
    expect(event).toMatchObject({ type: "status", tag: "codex_rate_limits", rateLimits: { limitId: "codex", primary: { usedPercent: 12, windowDurationMins: 10080 }, secondary: null } });
    expect(JSON.stringify(wire)).not.toContain("secret-marker");
    expect(JSON.stringify(event)).not.toContain("secret-marker");
  });
});
