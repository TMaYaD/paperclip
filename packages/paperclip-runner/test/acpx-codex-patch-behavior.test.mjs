import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const source = readFileSync(require.resolve("@agentclientprotocol/codex-acp"), "utf8");

function method(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `installed Codex ACP must contain ${start}`);
  return source.slice(from, to);
}

function client(methodSource, env, dependencies = {}) {
  const helper = method("function paperclipBaseInstructions(", "\nvar CodexAcpClient");
  return runInNewContext(`${helper}\n({${methodSource}})`, {
    process: { env },
    ...dependencies,
  });
}

const newSession = method("  async newSession(", "\n  async closeSession(");
const createSessionConfig = method("  async createSessionConfig(", "\n  async getConfigMcpServerNames(");
const refreshSkills = method("  async refreshSkills(", "\n  /**",);
const handleElicitation = method("  async handleElicitation(", "\n  async handleUserInput(");
const buildPermissionRequest = method("  buildPermissionRequest(", "\n  convertPermissionResponse(");
const createUpdateEvent = method("  async createUpdateEvent(", "\n  createCodexSessionInfoUpdate(");
const createCodexSessionInfoUpdate = method("  createCodexSessionInfoUpdate(", "\n  async createTextEvent(");

test("isolated sessions forward their supplied instructions to Codex threadStart", async () => {
  for (const [env, prompt, expected] of [
    [{ PAPERCLIP_ACPX_ISOLATED_CONTEXT: "1" }, { append: "run instructions" }, "run instructions"],
    [{ PAPERCLIP_RUNNER_HOME_MODE: "preconfigured" }, "operator instructions", "operator instructions"],
    [{}, "untrusted instructions", undefined],
  ]) {
    const sentinel = new Error("threadStart captured");
    let args;
    const acp = client(newSession, env, {
      readAdditionalDirectories: () => [],
    });
    acp.refreshSkills = async () => {};
    acp.createSessionConfig = async () => ({});
    acp.getModelProvider = () => "openai";
    acp.codexClient = { threadStart: async (value) => { args = value; throw sentinel; } };
    await assert.rejects(acp.newSession({ cwd: "/work", mcpServers: [], _meta: { systemPrompt: prompt } }), sentinel);
    assert.equal(args.baseInstructions, expected);
  }
});

test("isolated session config disables inherited apps and MCP servers", async () => {
  const acp = client(createSessionConfig, { PAPERCLIP_ACPX_ISOLATED_CONTEXT: "1" }, {
    mergeGatewayConfig: (config) => config,
    mergeSandboxWorkspaceWriteRoots: (config) => config,
    logger: { log() {} },
  });
  acp.config = { "mcp_servers": { inherited: { command: "old" } }, "features.apps": true };
  acp.gatewayConfig = null;
  acp.getNativeProviderConfig = () => ({ apiType: "responses", baseUrl: null });
  acp.getModelProvider = () => "openai";
  const config = await acp.createSessionConfig("/work", [], []);
  assert.deepEqual(JSON.parse(JSON.stringify(config["mcp_servers"])), {});
  assert.equal(config["features.apps"], false);
  assert.equal(config["features.memory_tool"], false);
  assert.equal(config.include_apps_instructions, false);
  assert.equal(config["skills.include_instructions"], true);
});

test("isolated skill refresh reads only the selected home", async () => {
  const calls = [];
  const acp = client(refreshSkills, { PAPERCLIP_ACPX_ISOLATED_CONTEXT: "1", CODEX_HOME: "/isolated/home" }, {
    arraysEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });
  acp.skillExtraRoots = ["/old/root"];
  acp.codexClient = {
    skillsExtraRootsSet: async (value) => calls.push(["roots", value]),
    listSkills: async (value) => calls.push(["list", value]),
  };
  await acp.refreshSkills("/work", ["/extra"]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["roots", { extraRoots: [] }],
    ["list", { cwds: ["/isolated/home"], forceReload: true }],
  ]);
});

test("MCP tool approval uses permission request and preserves server identity", async () => {
  const calls = [];
  const acp = client(`${handleElicitation},\n${buildPermissionRequest}`, {}, {
    methods: { client: { elicitation: { create: "elicitation" }, session: { requestPermission: "permission", update: "update" } } },
    buildToolApprovalOptions: () => [{ optionId: "decline" }],
    ELICITATION_OPTIONS: [],
    logger: { error(error) { throw error; } },
  });
  acp.sessionState = { sessionId: "thread" };
  acp.createMcpElicitationContext = () => ({ isToolApproval: true, correlatedCallId: "call-1", persistOptions: [] });
  acp.shouldUseAcpElicitation = () => true;
  acp.requestOptions = () => undefined;
  acp.convertPermissionResponse = () => ({ action: "cancel" });
  acp.connection = { request: async (methodName, request) => {
    calls.push([methodName, request]);
    return { outcome: { outcome: "cancelled" } };
  } };
  await acp.handleElicitation({ mode: "form", threadId: "thread", serverName: "tools", message: "approve?" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "permission");
  assert.equal(calls[0][1].toolCall.toolCallId, "call-1");
  assert.equal(calls[0][1].toolCall.rawInput.serverName, "tools");
});

test("Codex rate limit notifications reach ACP session metadata", async () => {
  const acp = client(`${createUpdateEvent},\n${createCodexSessionInfoUpdate}`, {});
  let received;
  acp.handleRateLimitsUpdated = (value) => { received = value; };
  const params = { rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1234 },
    secondary: null,
  } };
  const update = await acp.createUpdateEvent({ method: "account/rateLimits/updated", params });
  assert.equal(received, params);
  assert.deepEqual(JSON.parse(JSON.stringify(update)), {
    sessionUpdate: "session_info_update",
    _meta: { codex: { rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1234 },
      secondary: null,
    } } },
  });
});
