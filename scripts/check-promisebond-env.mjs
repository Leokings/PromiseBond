import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { keccak256, stringToHex } from "viem";

const rootPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const environmentDirectory = path.join(rootPath, "config", "promisebond");
const releaseManifestPath = path.join(environmentDirectory, "contract-releases.json");

dotenv.config({ path: path.join(environmentDirectory, ".env.promisebond.local"), quiet: true });
dotenv.config({ path: path.join(environmentDirectory, ".env.local"), quiet: true });
dotenv.config({ path: path.join(environmentDirectory, ".env.promisebond"), quiet: true });
dotenv.config({ path: path.join(environmentDirectory, ".env"), quiet: true });

const strict = process.argv.includes("--strict");
const failures = [];
const warnings = [];

function value(name) {
  return process.env[name]?.trim() ?? "";
}

function configured(name) {
  return Boolean(value(name));
}

function requireVariable(name, description) {
  if (configured(name)) return;
  (strict ? failures : warnings).push(`${name}: ${description}`);
}

function requireExact(name, expected) {
  const actual = value(name);
  if (actual && actual !== expected) {
    failures.push(`${name} must be ${expected}`);
  }
}

function requireHttpsUrl(name) {
  const candidate = value(name);
  if (!candidate) return;
  try {
    if (new URL(candidate).protocol !== "https:") {
      failures.push(`${name} must use HTTPS`);
    }
  } catch {
    failures.push(`${name} is not a valid URL`);
  }
}

for (const [name, description] of [
  ["PROMISEBOND_ENVIRONMENT", "staging environment marker"],
  ["VITE_PROMISEBOND_GENLAYER_RPC_URL", "browser GenLayer Bradbury RPC"],
  ["VITE_PROMISEBOND_WALLET_RPC_URL", "browser wallet EVM RPC for GenLayer chain 4221"],
  ["VITE_PROMISEBOND_GENLAYER_CHAIN_ID", "browser Bradbury chain ID"],
  ["VITE_PROMISEBOND_GENLAYER_NETWORK", "browser Bradbury network name"],
  ["VITE_PROMISEBOND_GENLAYER_EXPLORER_URL", "Bradbury explorer"],
  ["VITE_PROMISEBOND_GENLAYER_FAUCET_URL", "Bradbury test GEN faucet"],
  ["VITE_PROMISEBOND_NATIVE_ASSET_SYMBOL", "browser native asset symbol"],
  ["VITE_PROMISEBOND_NATIVE_ASSET_DECIMALS", "browser native asset decimals"],
  ["PROMISEBOND_GENLAYER_RPC_URL", "server GenLayer Bradbury RPC"],
  ["PROMISEBOND_GENLAYER_CHAIN_ID", "server Bradbury chain ID"],
  ["PROMISEBOND_GENLAYER_NETWORK", "server Bradbury network name"],
  ["PROMISEBOND_NATIVE_ASSET_SYMBOL", "server native asset symbol"],
  ["PROMISEBOND_NATIVE_ASSET_DECIMALS", "server native asset decimals"],
  ["PROMISEBOND_CONTRACT_RELEASE", "tracked native contract release"],
  ["PROMISEBOND_CONTRACT_SOURCE_HASH", "keccak256 of the reviewed native contract source"],
  ["PROMISEBOND_FINALITY_POLL_INTERVAL_MS", "finalized receipt polling interval"],
  ["PROMISEBOND_FINALITY_POLL_RETRIES", "finalized receipt polling retry policy"],
  ["PROMISEBOND_MONGODB_URI", "dedicated PromiseBond database credential"],
  ["PROMISEBOND_MONGODB_DB_NAME", "dedicated PromiseBond database name"],
  ["PROMISEBOND_CRON_SECRET", "scheduled-worker authentication secret"]
]) {
  requireVariable(name, description);
}

const forbiddenLegacyVariables = [
  "VITE_PROMISEBOND_BASE_SEPOLIA_RPC_URL",
  "VITE_PROMISEBOND_ESCROW_ADDRESS",
  "PROMISEBOND_BASE_SEPOLIA_RPC_URL",
  "PROMISEBOND_BASE_TOKEN_ADDRESS",
  "PROMISEBOND_USDC_ADDRESS",
  "PROMISEBOND_ESCROW_ADDRESS",
  "PROMISEBOND_ESCROW_OWNER_ADDRESS",
  "PROMISEBOND_DEPLOYER_ADDRESS",
  "PROMISEBOND_VERDICT_SIGNER_ADDRESS",
  "PROMISEBOND_ATTESTER_ADDRESS",
  "PROMISEBOND_APPROVED_RESOLVER_CODE_HASHES",
  "PROMISEBOND_PRIVATE_KEY",
  "PROMISEBOND_DEPLOYER_PRIVATE_KEY",
  "PROMISEBOND_ATTESTER_PRIVATE_KEY"
];
for (const name of forbiddenLegacyVariables) {
  if (configured(name)) {
    failures.push(`${name} is parked legacy configuration and must not be set for the native release`);
  }
}

requireExact("PROMISEBOND_ENVIRONMENT", "staging");
requireExact("VITE_PROMISEBOND_GENLAYER_CHAIN_ID", "4221");
requireExact("PROMISEBOND_GENLAYER_CHAIN_ID", "4221");
requireExact("VITE_PROMISEBOND_GENLAYER_NETWORK", "bradbury");
requireExact("PROMISEBOND_GENLAYER_NETWORK", "bradbury");
requireExact("VITE_PROMISEBOND_NATIVE_ASSET_SYMBOL", "GEN");
requireExact("PROMISEBOND_NATIVE_ASSET_SYMBOL", "GEN");
requireExact("VITE_PROMISEBOND_NATIVE_ASSET_DECIMALS", "18");
requireExact("PROMISEBOND_NATIVE_ASSET_DECIMALS", "18");

for (const name of [
  "VITE_PROMISEBOND_GENLAYER_RPC_URL",
  "VITE_PROMISEBOND_WALLET_RPC_URL",
  "VITE_PROMISEBOND_GENLAYER_EXPLORER_URL",
  "VITE_PROMISEBOND_GENLAYER_FAUCET_URL",
  "PROMISEBOND_GENLAYER_RPC_URL"
]) {
  requireHttpsUrl(name);
}

const sourceHash = value("PROMISEBOND_CONTRACT_SOURCE_HASH");
if (sourceHash && !/^0x[0-9a-fA-F]{64}$/.test(sourceHash)) {
  failures.push("PROMISEBOND_CONTRACT_SOURCE_HASH must be a bytes32 keccak256 hash");
}

const promiseBondDbName = value("PROMISEBOND_MONGODB_DB_NAME").toLowerCase();
if (promiseBondDbName === "backit") {
  failures.push("PROMISEBOND_MONGODB_DB_NAME must not use the BackIt database");
}
const promiseBondMongoUri = value("PROMISEBOND_MONGODB_URI");
const backItMongoUri = value("MONGODB_URI");
if (promiseBondMongoUri && backItMongoUri && promiseBondMongoUri === backItMongoUri) {
  failures.push("PROMISEBOND_MONGODB_URI must use a credential isolated from BackIt");
}

for (const [name, allowZero] of [
  ["PROMISEBOND_FINALITY_POLL_INTERVAL_MS", false],
  ["PROMISEBOND_FINALITY_POLL_RETRIES", true]
]) {
  const candidate = value(name);
  if (candidate && (!/^\d+$/.test(candidate) || Number(candidate) < (allowZero ? 0 : 1))) {
    failures.push(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
}

try {
  const manifest = JSON.parse(fs.readFileSync(releaseManifestPath, "utf8"));
  if (manifest.network !== "bradbury" || manifest.genLayerChainId !== 4_221) {
    failures.push("contract release manifest must target GenLayer Bradbury chain 4221");
  }
  if (manifest.genlayerJsVersion !== "1.1.8") {
    failures.push("contract release manifest must pin genlayer-js 1.1.8");
  }
  if (
    manifest.nativeAsset?.kind !== "native" ||
    manifest.nativeAsset?.symbol !== "GEN" ||
    manifest.nativeAsset?.decimals !== 18 ||
    manifest.nativeAsset?.testnet !== true
  ) {
    failures.push("contract release manifest must pin native 18-decimal test GEN");
  }

  const releaseName = value("PROMISEBOND_CONTRACT_RELEASE") || manifest.activeRelease;
  const release = manifest.releases?.find(({ release: name }) => name === releaseName);
  if (!release || releaseName !== manifest.activeRelease) {
    failures.push("PROMISEBOND_CONTRACT_RELEASE must select the manifest active release");
  } else {
    if (release.policyVersion !== "promisebond.native-gen.v1") {
      failures.push("active release must pin promisebond.native-gen.v1");
    }
    if (!/^py-genlayer:[a-z0-9]+$/.test(release.runnerDependency ?? "")) {
      failures.push("active release must pin a concrete py-genlayer runner dependency");
    }
    if (release.sourcePath !== "contracts/PromiseBond.py") {
      failures.push("active release must point to contracts/PromiseBond.py");
    } else {
      const source = fs.readFileSync(path.join(rootPath, release.sourcePath), "utf8");
      const actualHash = keccak256(stringToHex(source));
      if (release.sourceKeccak256?.toLowerCase() !== actualHash.toLowerCase()) {
        failures.push("active release source hash does not match contracts/PromiseBond.py");
      }
      if (sourceHash && sourceHash.toLowerCase() !== actualHash.toLowerCase()) {
        failures.push("PROMISEBOND_CONTRACT_SOURCE_HASH does not match contracts/PromiseBond.py");
      }
    }
  }
} catch (error) {
  failures.push(`unable to validate native contract release manifest: ${error.message}`);
}

console.log(`PromiseBond environment check (${strict ? "strict staging" : "local"} mode)`);
console.log("Expected chain: GenLayer Bradbury 4221. Custody asset: native test GEN (18 decimals).");
console.log("No Base RPC, escrow, attester, private key, or signing secret is used.");
console.log("Secrets are never printed.");

for (const warning of warnings) console.log(`[WARN] ${warning}`);
for (const failure of failures) console.log(`[INVALID] ${failure}`);

if (failures.length > 0) {
  console.log(`Environment check failed with ${failures.length} issue${failures.length === 1 ? "" : "s"}.`);
  process.exitCode = 1;
} else {
  console.log("Environment check passed.");
}
