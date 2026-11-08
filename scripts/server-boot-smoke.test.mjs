import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const smoke = new URL("./server-boot-smoke.mjs", import.meta.url).pathname;

for (const [status, expectedExit] of [[200, 0], [503, 1]]) {
  test(`built-server smoke ${status === 200 ? "accepts healthy response" : "rejects unhealthy response"}`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paperclip-boot-fixture-"));
    try {
      const entry = path.join(dir, "server.mjs");
      writeFileSync(entry, `import http from "node:http"; http.createServer((_req, res) => { res.writeHead(${status}, {"content-type":"application/json"}); res.end(JSON.stringify({status:"${status === 200 ? "ok" : "error"}"})); }).listen(Number(process.env.PORT), process.env.HOST);\n`);
      const result = spawnSync(process.execPath, [smoke, "--server-entry", entry, "--timeout-ms", "1000"], { encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, expectedExit, result.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
