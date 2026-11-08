import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { listProviderPackages, installArgs } from "../test-sandbox-providers.mjs";

test("discovers every standalone provider with a test and typecheck script", () => {
  const providers = listProviderPackages(path.resolve("packages/plugins/sandbox-providers"));
  assert.deepEqual(providers.map(({ name }) => name), [
    "cloudflare", "createos", "daytona", "e2b", "exe-dev", "kubernetes", "modal", "novita",
  ]);
});

test("uses Daytona's committed lockfile and avoids creating others", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sandbox-provider-test-"));
  try {
    const daytona = path.join(root, "daytona");
    const e2b = path.join(root, "e2b");
    mkdirSync(daytona);
    mkdirSync(e2b);
    writeFileSync(path.join(daytona, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    assert.deepEqual(installArgs(daytona), ["install", "--ignore-workspace", "--frozen-lockfile"]);
    assert.deepEqual(installArgs(e2b), ["install", "--ignore-workspace", "--no-lockfile"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
