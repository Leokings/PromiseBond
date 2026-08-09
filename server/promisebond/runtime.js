import {
  GENLAYER_BRADBURY_IDENTITY,
  createPromiseBondBradburyReadClient
} from "../../shared/promisebond/bradbury-native.js";
import { createPromiseBondApp } from "./app.js";
import {
  getPromiseBondDb,
  isPromiseBondMongoConfigured
} from "./db.js";
import { createPromiseBondRepository } from "./repository.js";
import { runPromiseBondWorkerOnce } from "./worker.js";

function optionalPromiseBondEnv(name) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function integerPromiseBondEnv(name, fallback, minimum, maximum) {
  const value = optionalPromiseBondEnv(name);
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

function bodyLimitPromiseBondEnv() {
  const value = optionalPromiseBondEnv("PROMISEBOND_JSON_BODY_LIMIT");
  if (!value) return 2_048;
  const match = /^(\d+)(b|kb)?$/i.exec(value);
  if (!match) throw new Error("PROMISEBOND_JSON_BODY_LIMIT must be between 256b and 256kb");
  const multiplier = match[2]?.toLowerCase() === "kb" ? 1_024 : 1;
  const bytes = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(bytes) || bytes < 256 || bytes > 262_144) {
    throw new Error("PROMISEBOND_JSON_BODY_LIMIT must be between 256b and 256kb");
  }
  return bytes;
}

function booleanPromiseBondEnv(name, fallback) {
  const value = optionalPromiseBondEnv(name);
  if (!value) return fallback;
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
  return value === "true";
}

/** Creates the deployable PromiseBond runtime exclusively from injected process values. */
export function createPromiseBondRuntime() {
  let repositoryPromise;
  let readClient;
  const jobLeaseMs = integerPromiseBondEnv(
    "PROMISEBOND_JOB_LEASE_MS",
    30_000,
    2_000,
    300_000
  );
  const chainReadTimeoutMs = integerPromiseBondEnv(
    "PROMISEBOND_CHAIN_READ_TIMEOUT_MS",
    20_000,
    250,
    120_000
  );
  if (chainReadTimeoutMs > jobLeaseMs - 1_000) {
    throw new Error(
      "PROMISEBOND_CHAIN_READ_TIMEOUT_MS must leave at least one second in PROMISEBOND_JOB_LEASE_MS"
    );
  }
  const promiseBondCronSecret = optionalPromiseBondEnv("PROMISEBOND_CRON_SECRET");
  const platformCronSecret = process.env.CRON_SECRET?.trim() || undefined;
  if (process.env.VERCEL === "1" && (
    !promiseBondCronSecret || !platformCronSecret ||
    Buffer.byteLength(promiseBondCronSecret, "utf8") < 24 ||
    promiseBondCronSecret !== platformCronSecret
  )) {
    throw new Error(
      "Vercel PromiseBond requires equal PROMISEBOND_CRON_SECRET and CRON_SECRET values of at least 24 bytes"
    );
  }

  async function getRepository() {
    if (!repositoryPromise) {
      repositoryPromise = getPromiseBondDb().then((database) => (
        database ? createPromiseBondRepository({ database }) : undefined
      )).catch((error) => {
        repositoryPromise = undefined;
        throw error;
      });
    }
    return repositoryPromise;
  }

  function getReadClient() {
    if (!readClient) {
      readClient = createPromiseBondBradburyReadClient({
        rpcUrl: optionalPromiseBondEnv("PROMISEBOND_GENLAYER_RPC_URL") ||
          GENLAYER_BRADBURY_IDENTITY.officialRpcUrl
      });
    }
    return readClient;
  }

  const app = createPromiseBondApp({
    getRepository,
    getReadClient,
    isDatabaseConfigured: isPromiseBondMongoConfigured,
    cronSecret: promiseBondCronSecret,
    bodyLimitBytes: bodyLimitPromiseBondEnv(),
    trustProxy: booleanPromiseBondEnv("PROMISEBOND_TRUST_PROXY", false),
    rateLimitWindowMs: integerPromiseBondEnv(
      "PROMISEBOND_RATE_LIMIT_WINDOW_MS",
      60_000,
      1_000,
      3_600_000
    ),
    rateLimitMax: integerPromiseBondEnv("PROMISEBOND_RATE_LIMIT_MAX", 60, 1, 1_000),
    workerBatchSize: integerPromiseBondEnv("PROMISEBOND_WORKER_BATCH_SIZE", 25, 1, 100),
    workerMaxRuntimeMs: integerPromiseBondEnv(
      "PROMISEBOND_WORKER_MAX_RUNTIME_MS",
      240_000,
      5_000,
      280_000
    ),
    runWorkerOnce: ({ repository, client, workerId }) => runPromiseBondWorkerOnce({
      repository,
      client,
      workerId,
      reconcileIntervalMs: integerPromiseBondEnv(
        "PROMISEBOND_RECONCILE_INTERVAL_MS",
        60_000,
        5_000,
        86_400_000
      ),
      leaseMs: jobLeaseMs,
      readTimeoutMs: chainReadTimeoutMs,
      retryBaseMs: integerPromiseBondEnv(
        "PROMISEBOND_JOB_RETRY_BASE_MS",
        5_000,
        1_000,
        300_000
      )
    })
  });

  return Object.freeze({ app, getReadClient, getRepository });
}

const runtime = createPromiseBondRuntime();
export default runtime.app;
