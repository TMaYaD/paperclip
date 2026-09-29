import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materializePublishManifest, prepareBundledPackage } from "./prepare-bundled-package.mjs";

test("staged manifests omit packing hooks without changing source or runtime scripts", () => {
  const scripts = {
    prepack: "build-source", prepare: "prepare-source", postpack: "clean-source",
    build: "build", start: "node dist/index.js", postinstall: "install-runtime",
  };
  const source = { name: "fixture", version: "1.0.0", scripts };
  const staged = materializePublishManifest(source);
  assert.deepEqual(staged.scripts, {
    build: "build", start: "node dist/index.js", postinstall: "install-runtime",
  });
  assert.equal(source.scripts, scripts);
  assert.equal(source.scripts.prepack, "build-source");
  assert.equal(source.scripts.prepare, "prepare-source");
  assert.equal(source.scripts.postpack, "clean-source");
  assert.equal(Object.hasOwn(materializePublishManifest({ name: "no-scripts", version: "1.0.0" }), "scripts"), false);
});

test("plain npm pack of a prepared bundle works outside the workspace and retains built assets", { timeout: 60_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-staged-pack-")));
  const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  const npm = (args, cwd) => execFileSync("npm", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, npm_config_ignore_scripts: "false", npm_config_update_notifier: "false" },
    timeout: 30_000,
  });
  try {
    const workspace = join(root, "workspace");
    const source = join(workspace, "server");
    const staged = join(root, "workspace-package-0");
    const dependency = join(root, "dependency");
    mkdirSync(join(workspace, "scripts"), { recursive: true });
    json(join(workspace, "package.json"), { private: true });
    json(join(workspace, "scripts/release-package-manifest.json"), []);
    mkdirSync(dependency);
    json(join(dependency, "package.json"), { name: "fixture-bundled", version: "1.0.0", main: "index.js" });
    writeFileSync(join(dependency, "index.js"), "module.exports = 'bundled runtime';\n");
    npm(["pack", "--ignore-scripts", "--pack-destination", root], dependency);
    for (const dir of ["dist", "ui-dist", "skills"]) mkdirSync(join(source, dir), { recursive: true });
    writeFileSync(join(source, "dist/index.js"), "module.exports = require('fixture-bundled');\n");
    writeFileSync(join(source, "ui-dist/index.html"), "built UI\n");
    writeFileSync(join(source, "skills/SKILL.md"), "runtime skill\n");
    const failHook = "node -e \"throw new Error('workspace build hook must not run')\"";
    const manifest = {
      name: "fixture-server", version: "1.0.0", main: "dist/index.js",
      files: ["dist", "ui-dist", "skills"],
      dependencies: { "fixture-bundled": `file:${join(root, "fixture-bundled-1.0.0.tgz")}` },
      devDependencies: { "fixture-ui": "workspace:*" },
      bundleDependencies: ["fixture-bundled"],
      scripts: { prepack: failHook, prepare: failHook, postpack: failHook, start: "node dist/index.js" },
    };
    json(join(source, "package.json"), manifest);
    prepareBundledPackage(source, staged, { sourceRoot: workspace });
    // Old installed CLIs call plain npm pack: fixing only the new CLI flag is insufficient.
    npm(["pack", staged, "--pack-destination", root], root);
    const unpacked = join(root, "unpacked");
    mkdirSync(unpacked);
    execFileSync("tar", ["-xzf", join(root, "fixture-server-1.0.0.tgz"), "-C", unpacked]);
    const packed = join(unpacked, "package");
    assert.equal(execFileSync(process.execPath, ["-p", "require('./dist/index.js')"], { cwd: packed, encoding: "utf8" }).trim(), "bundled runtime");
    assert.equal(readFileSync(join(packed, "ui-dist/index.html"), "utf8"), "built UI\n");
    assert.equal(readFileSync(join(packed, "skills/SKILL.md"), "utf8"), "runtime skill\n");
    assert.ok(existsSync(join(packed, "node_modules/fixture-bundled/index.js")));
    assert.deepEqual(JSON.parse(readFileSync(join(source, "package.json"), "utf8")), manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
