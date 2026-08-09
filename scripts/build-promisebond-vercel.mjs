import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required for the PromiseBond Vercel build");

function run(arguments_) {
  const result = spawnSync(process.execPath, [npmCli, ...arguments_], {
    cwd: root,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// The legacy output allowlist deliberately bypasses zero-config dependency installation.
// Vercel starts clean; local validation can safely reuse the repository's existing install.
if (!existsSync(path.join(root, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite"))) {
  run(["ci"]);
}

run(["run", "build:promisebond"]);
