import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import dotenv from "dotenv";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(directory, "..", "..");
const environmentDirectory = path.join(root, "config", "promisebond");
for (const name of [".env.promisebond.local", ".env.local", ".env.promisebond", ".env"]) {
  dotenv.config({ path: path.join(environmentDirectory, name), quiet: true });
}

function optionalLocalEnv(name) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function integerLocalEnv(name, fallback, minimum, maximum) {
  const value = optionalLocalEnv(name);
  if (!value) return fallback;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

// Dynamic import is intentional: local dotenv files must load before the runtime snapshots its
// configuration, while the Vercel adapter imports runtime.js directly and never traces this file.
const runtimeModule = await import("./runtime.js");
export const createPromiseBondRuntime = runtimeModule.createPromiseBondRuntime;
const app = runtimeModule.default;
export default app;

const directlyInvoked = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (directlyInvoked) {
  const port = integerLocalEnv("PROMISEBOND_PORT", 8_790, 1, 65_535);
  const host = optionalLocalEnv("PROMISEBOND_HOST") || "127.0.0.1";
  app.listen(port, host, () => {
    console.log(`PromiseBond API listening on http://${host}:${port} (${randomUUID().slice(0, 8)})`);
  });
}
