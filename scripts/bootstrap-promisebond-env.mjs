import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const environmentDirectory = path.join(rootPath, "config", "promisebond");
const templatePath = path.join(environmentDirectory, ".env.example");
const localPath = path.join(environmentDirectory, ".env.local");

if (existsSync(localPath)) {
  console.log("PromiseBond local environment already exists; nothing was overwritten.");
  process.exit(0);
}

const cronSecret = randomBytes(32).toString("hex");
const template = readFileSync(templatePath, "utf8");
const configured = template.replace(
  /^PROMISEBOND_CRON_SECRET=$/m,
  `PROMISEBOND_CRON_SECRET=${cronSecret}`
);

writeFileSync(localPath, configured, { encoding: "utf8", flag: "wx", mode: 0o600 });

console.log("Created config/promisebond/.env.local with isolated safe local defaults.");
console.log("A cron secret was generated and was not printed.");
console.log("External value still required for strict staging: a dedicated PromiseBond MongoDB URI.");
console.log("No private key, escrow signer, attester, or Base RPC is configured by this script.");
