import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

type Manifest = {
  name: string;
  version: string;
  files?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
  publishConfig?: Record<string, unknown>;
  [key: string]: unknown;
};
const readManifest = (directory: string): Manifest => JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));

function installedDependency(issuer: string, name: string): string | undefined {
  const lookup = createRequire(path.join(issuer, "package.json")).resolve.paths(`${name}/package.json`) ?? [];
  for (const modules of lookup) {
    const candidate = path.join(modules, name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
  }
  return undefined;
}

/** Copy installed bytes, never resolve ranges, fetch packages, or run lifecycle scripts. */
export function materializeGitPayload(checkoutPath: string, payloadPath: string): void {
  const checkout = fs.realpathSync(checkoutPath);
  const cliSource = path.join(checkout, "cli");
  const builtCli = readManifest(cliSource);
  const originalCli: Manifest = JSON.parse(fs.readFileSync(path.join(cliSource, "package.dev.json"), "utf8"));
  const entries: { dir: string; name: string }[] = JSON.parse(fs.readFileSync(path.join(checkout, "scripts/release-package-manifest.json"), "utf8"));
  const workspaces = new Set(entries.map(entry => fs.realpathSync(path.join(checkout, entry.dir))));
  workspaces.add(cliSource);
  const modules = path.join(payloadPath, "node_modules");
  const copied = new Map<string, { directory: string; manifest: Manifest }>();
  fs.mkdirSync(modules, { recursive: true });

  const link = (from: string, to: string, type: "dir" | "file" = "dir"): void => {
    fs.mkdirSync(path.dirname(from), { recursive: true });
    fs.symlinkSync(path.relative(path.dirname(from), to), from, type);
  };
  const copy = (source: string, destination: string): void => {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(source), destination);
    } else if (stat.isDirectory()) {
      fs.mkdirSync(destination, { recursive: true });
      for (const entry of fs.readdirSync(source)) {
        if (entry !== "node_modules") copy(path.join(source, entry), path.join(destination, entry));
      }
    } else if (stat.isFile()) {
      // APFS reflinks avoid copying native binaries, without sharing mutable inodes
      // with the build workspace. Other filesystems fall back to a regular copy.
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE);
    }
  };

  const stage = (source: string): { directory: string; manifest: Manifest } => {
    const existing = copied.get(source);
    if (existing) return existing;
    const original = source === cliSource ? originalCli : readManifest(source);
    const manifest: Manifest = { ...original };
    const directory = source === cliSource ? path.join(modules, "paperclipai")
      : path.join(modules, ".paperclip", String(copied.size), "node_modules", original.name);
    const result = { directory, manifest };
    // Memoize before walking dependencies to preserve peer contexts and cycles.
    copied.set(source, result);
    fs.mkdirSync(directory, { recursive: true });
    if (workspaces.has(source)) {
      for (const entry of original.files ?? []) {
        if (entry.includes("*") || path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) {
          throw new Error(`Unsupported git payload files entry: ${original.name}: ${entry}`);
        }
        if (!fs.existsSync(path.join(source, entry))) {
          if (entry === "dist") throw new Error(`Missing built git payload asset: ${original.name}/${entry}`);
          continue; // npm pack also ignores absent files entries (some adapter skills).
        }
        fs.mkdirSync(path.dirname(path.join(directory, entry)), { recursive: true });
        copy(path.join(source, entry), path.join(directory, entry));
      }
      for (const entry of ["README.md", "LICENSE", "LICENSE.md"]) {
        const local = path.join(source, entry);
        const inherited = entry.startsWith("LICENSE") ? path.join(checkout, entry) : local;
        const candidate = fs.existsSync(local) ? local : inherited;
        if (fs.existsSync(candidate) && !fs.existsSync(path.join(directory, entry))) copy(candidate, path.join(directory, entry));
      }
      // The server postinstall normally creates these OUTSIDE its files list.
      // Source builds already materialize and verify the host's pinned closure.
      if (original.name === "@paperclipai/server" && fs.existsSync(path.join(source, "provider-assets"))) {
        copy(path.join(source, "provider-assets"), path.join(directory, "provider-assets"));
      }
      for (const key of ["main", "types", "exports", "bin"]) {
        if (original.publishConfig?.[key] !== undefined) manifest[key] = original.publishConfig[key];
      }
      delete manifest.publishConfig;
      delete manifest.devDependencies;
      delete manifest.bundleDependencies;
      delete manifest.bundledDependencies;
    } else {
      for (const entry of fs.readdirSync(source)) {
        if (entry !== "node_modules" && entry !== "package.json") copy(path.join(source, entry), path.join(directory, entry));
      }
    }
    const dependencies = { ...original.peerDependencies, ...original.dependencies, ...original.optionalDependencies };
    for (const [name, specifier] of Object.entries(dependencies)) {
      const dependency = installedDependency(source, name);
      if (!dependency) {
        if (original.optionalDependencies?.[name] !== undefined || original.dependencies?.[name] === undefined) continue;
        throw new Error(`Missing installed production dependency ${original.name} -> ${name}`);
      }
      if (specifier.startsWith("workspace:") && !workspaces.has(dependency)) {
        throw new Error(`Workspace dependency resolved outside the checkout: ${original.name} -> ${name}`);
      }
      const target = stage(dependency);
      link(path.join(directory, "node_modules", name), target.directory);
      if (specifier.startsWith("workspace:")) {
        for (const section of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
          if (manifest[section]?.[name]) manifest[section] = { ...manifest[section], [name]: target.manifest.version };
        }
      }
      const bins = typeof target.manifest.bin === "string" ? { [name.split("/").at(-1)!]: target.manifest.bin } : target.manifest.bin ?? {};
      for (const [command, file] of Object.entries(bins)) {
        const binPath = path.join(directory, "node_modules/.bin", command);
        if (!fs.existsSync(path.join(target.directory, file)) || fs.existsSync(binPath)) continue;
        link(binPath, path.join(target.directory, file), "file");
      }
    }
    fs.writeFileSync(path.join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return result;
  };
  const cli = stage(cliSource);
  // esbuild leaves external imports from bundled workspace code in the CLI.
  // Resolve each from the workspace that declared it, using the installed graph.
  for (const section of ["dependencies", "optionalDependencies"] as const) {
    for (const [name, specifier] of Object.entries(builtCli[section] ?? {})) {
      const destination = path.join(cli.directory, "node_modules", name);
      if (fs.existsSync(destination)) continue;
      const issuer = [...copied.keys()].find(source => {
        const pkg = source === cliSource ? originalCli : readManifest(source);
        return pkg.dependencies?.[name] === specifier || pkg.optionalDependencies?.[name] === specifier;
      });
      const dependency = issuer && installedDependency(issuer, name);
      if (!dependency) {
        if (section === "optionalDependencies") continue;
        throw new Error(`Cannot locate installed CLI external ${name}@${specifier}`);
      }
      link(destination, stage(dependency).directory);
    }
  }
  cli.manifest.dependencies = { ...builtCli.dependencies, ...cli.manifest.dependencies };
  cli.manifest.optionalDependencies = { ...builtCli.optionalDependencies, ...cli.manifest.optionalDependencies };
  fs.writeFileSync(path.join(cli.directory, "package.json"), `${JSON.stringify(cli.manifest, null, 2)}\n`);
  // Preserve the historical top-level server/workspace lookup layout.
  for (const [source, target] of copied) {
    if (source !== cliSource && workspaces.has(source)) link(path.join(modules, target.manifest.name), target.directory);
  }
}

/** All runtime links must survive both staging deletion and payload rename. */
export function assertSelfContainedPayload(payloadPath: string): void {
  const root = fs.realpathSync(payloadPath);
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(candidate);
        const relative = path.relative(root, fs.realpathSync(candidate));
        if (path.isAbsolute(target) || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error(`Git payload link escapes its payload: ${candidate} -> ${target}`);
        }
      } else if (entry.isDirectory()) visit(candidate);
    }
  };
  visit(root);
}
