import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const depsStage = dockerfile.split(/^FROM .* AS deps$/m)[1]?.split(/^FROM /m)[0];

test("Docker deps stage supplies and executes the plugin SDK postinstall", () => {
  assert.ok(depsStage, "Dockerfile must define a deps stage");
  assert.match(depsStage, /^COPY scripts\/link-plugin-dev-sdk\.mjs scripts\/$/m);
  assert.equal(packageJson.scripts.postinstall, "node scripts/link-plugin-dev-sdk.mjs");
  assert.match(depsStage, /pnpm install --frozen-lockfile/);
  assert.doesNotMatch(depsStage, /pnpm install --frozen-lockfile --ignore-scripts/);
});
