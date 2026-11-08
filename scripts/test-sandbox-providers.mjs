#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linkSdkInto } from "./link-plugin-dev-sdk.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const providerRoot = path.join(repoRoot, "packages/plugins/sandbox-providers");

export function listProviderPackages(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => {
      const dir = path.join(directory, entry.name);
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      if (!manifest.scripts?.typecheck || !manifest.scripts?.test) {
        throw new Error(`${entry.name} must define typecheck and test scripts`);
      }
      return { name: entry.name, dir };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function installArgs(directory) {
  return existsSync(path.join(directory, "pnpm-lock.yaml"))
    ? ["install", "--ignore-workspace", "--frozen-lockfile"]
    : ["install", "--ignore-workspace", "--no-lockfile"];
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed in ${path.relative(repoRoot, cwd)} (${result.status})`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run("pnpm", ["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"], repoRoot);
  for (const provider of listProviderPackages(providerRoot)) {
    console.log(`Testing sandbox provider ${provider.name}`);
    run("pnpm", installArgs(provider.dir), provider.dir);
    linkSdkInto(provider.dir);
    run("pnpm", ["run", "typecheck"], provider.dir);
    run("pnpm", ["run", "test"], provider.dir);
  }
}
