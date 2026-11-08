#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const entry = path.resolve(option("--server-entry", path.join(root, "server/dist/index.js")));
const timeoutMs = Number(option("--timeout-ms", "90000"));
if (!existsSync(entry) || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
  throw new Error("Built server entry is missing or timeout is invalid");
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const port = await freePort();
const home = mkdtempSync(path.join(tmpdir(), "paperclip-built-server-"));
const url = `http://127.0.0.1:${port}/api/health`;
const child = spawn(process.execPath, [entry], {
  cwd: root,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    PORT: String(port),
    HOST: "127.0.0.1",
    PAPERCLIP_HOME: home,
    PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
    PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
    PAPERCLIP_API_URL: `http://127.0.0.1:${port}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let exited = false;
const exitPromise = new Promise((resolve) => child.once("exit", resolve));
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => { output = (output + chunk.toString()).slice(-12000); });
}
child.once("exit", () => { exited = true; });

let healthy = false;
try {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !exited) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).status === "ok") {
        healthy = true;
        break;
      }
    } catch { /* The listener may not be ready yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
} finally {
  if (!exited) {
    child.kill("SIGTERM");
    let timer;
    await Promise.race([
      exitPromise,
      new Promise((resolve) => { timer = setTimeout(resolve, 3000); }),
    ]);
    clearTimeout(timer);
    if (!exited) child.kill("SIGKILL");
  }
  rmSync(home, { recursive: true, force: true });
}

if (!healthy) {
  console.error(`Built server did not answer healthy at ${url}\n${output}`);
  process.exitCode = 1;
} else {
  console.log(`Built server answered healthy at ${url}`);
}
