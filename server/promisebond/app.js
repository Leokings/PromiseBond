import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import express from "express";

import {
  GENLAYER_BRADBURY_IDENTITY,
  assertPromiseBondBradburyClient,
  readFinalizedPromiseBond
} from "../../shared/promisebond/bradbury-native.js";
import {
  EVIDENCE_SOURCE_COUNT,
  EvidencePreflightError,
  preflightEvidence as defaultPreflightEvidence,
  validateEvidencePreflightInput
} from "./evidence-preflight.js";
import {
  PromiseBondValidationError,
  normalizeContractAddress,
  parsePublicListQuery,
  parseRegistrationBody
} from "./validation.js";

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

class OperationTimeoutError extends Error {
  constructor() {
    super("operation timed out");
    this.name = "OperationTimeoutError";
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function timeout(promise, milliseconds) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new OperationTimeoutError()), milliseconds);
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

function secretMatches(header, configuredSecret) {
  if (typeof configuredSecret !== "string" || Buffer.byteLength(configuredSecret, "utf8") < 24) return false;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  const expectedBytes = Buffer.from(configuredSecret, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function safeError(res, requestId, status, code, message) {
  res.status(status).json({ error: { code, message }, requestId });
}

export function createPromiseBondApp({
  getRepository,
  getReadClient,
  isDatabaseConfigured = () => true,
  readFinalized = readFinalizedPromiseBond,
  validateBradbury = assertPromiseBondBradburyClient,
  runWorkerOnce,
  cronSecret,
  now = () => Date.now(),
  createRequestId = randomUUID,
  bodyLimitBytes = 2_048,
  trustProxy = false,
  rateLimitWindowMs = 60_000,
  rateLimitMax = 60,
  healthTimeoutMs = 5_000,
  chainReadTimeoutMs = 30_000,
  maxConcurrentChainReads = 8,
  workerBatchSize = 25,
  workerMaxRuntimeMs = 240_000,
  maxConcurrentEvidencePreflights = 4,
  evidencePreflightQuotaWindowMs = 60_000,
  evidencePreflightGlobalSourceLimit = 300,
  evidencePreflightClientSourceLimit = 15,
  evidencePreflightClientHashKey = cronSecret,
  preflightEvidence = defaultPreflightEvidence,
  logger = console
} = {}) {
  if (typeof getRepository !== "function") throw new TypeError("getRepository is required");
  if (typeof getReadClient !== "function") throw new TypeError("getReadClient is required");
  if (typeof preflightEvidence !== "function") throw new TypeError("preflightEvidence must be a function");
  const bodyLimit = boundedInteger(bodyLimitBytes, 2_048, 256, 262_144);
  const windowMs = boundedInteger(rateLimitWindowMs, 60_000, 1_000, 3_600_000);
  const maxRequests = boundedInteger(rateLimitMax, 60, 1, 1_000);
  const healthTimeout = boundedInteger(healthTimeoutMs, 5_000, 250, 30_000);
  const chainTimeout = boundedInteger(chainReadTimeoutMs, 30_000, 1_000, 120_000);
  const maxChainReads = boundedInteger(maxConcurrentChainReads, 8, 1, 32);
  const maxWorkerJobs = boundedInteger(workerBatchSize, 25, 1, 100);
  const maxWorkerRuntime = boundedInteger(workerMaxRuntimeMs, 240_000, 5_000, 280_000);
  const maxEvidencePreflights = boundedInteger(maxConcurrentEvidencePreflights, 4, 1, 16);
  const evidenceQuotaWindow = boundedInteger(evidencePreflightQuotaWindowMs, 60_000, 1_000, 3_600_000);
  const evidenceGlobalSourceLimit = boundedInteger(
    evidencePreflightGlobalSourceLimit,
    300,
    EVIDENCE_SOURCE_COUNT,
    100_000
  );
  const evidenceClientSourceLimit = Math.min(evidenceGlobalSourceLimit, boundedInteger(
    evidencePreflightClientSourceLimit,
    15,
    EVIDENCE_SOURCE_COUNT,
    10_000
  ));
  const evidenceClientHashKey = typeof evidencePreflightClientHashKey === "string" &&
    Buffer.byteLength(evidencePreflightClientHashKey, "utf8") >= 16 &&
    Buffer.byteLength(evidencePreflightClientHashKey, "utf8") <= 1_024
    ? evidencePreflightClientHashKey
    : "promisebond-evidence-preflight-client-quota-v1";
  const buckets = new Map();
  let activeChainReads = 0;
  let activeEvidencePreflights = 0;
  const app = express();

  app.disable("x-powered-by");
  app.set("query parser", "simple");
  // Disabled by default so a direct client cannot spoof X-Forwarded-For. Operators may enable
  // exactly one trusted reverse-proxy hop (for example, the serverless ingress) explicitly.
  if (trustProxy === true) app.set("trust proxy", 1);

  function requestClientAddress(req) {
    return trustProxy === true
      ? (req.ip || req.socket?.remoteAddress || "unknown")
      : (req.socket?.remoteAddress || "unknown");
  }

  function evidenceClientHash(req) {
    return createHmac("sha256", evidenceClientHashKey)
      .update("promisebond:evidence-preflight:client:v1\0", "utf8")
      .update(requestClientAddress(req), "utf8")
      .digest("hex");
  }

  app.use((req, res, next) => {
    req.promiseBondRequestId = createRequestId();
    res.setHeader("X-Request-Id", req.promiseBondRequestId);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (req.path.startsWith("/api/promisebond")) res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.use("/api/promisebond", (req, res, next) => {
    // The cron endpoint is protected independently with a high-entropy bearer secret. Keeping it
    // out of anonymous buckets prevents public traffic behind the same ingress from starving jobs.
    if (req.path.startsWith("/internal/")) {
      next();
      return;
    }
    const currentTime = Number(now());
    const clientAddress = requestClientAddress(req);
    const key = `public:${clientAddress}`;
    const existing = buckets.get(key);
    const bucket = existing && existing.resetAt > currentTime
      ? existing
      : { count: 0, resetAt: currentTime + windowMs };
    bucket.count += 1;
    if (!existing && buckets.size >= 10_000) {
      const oldestKey = buckets.keys().next().value;
      if (oldestKey !== undefined) buckets.delete(oldestKey);
    }
    buckets.set(key, bucket);
    res.setHeader("X-RateLimit-Limit", String(maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, maxRequests - bucket.count)));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1_000)));
    if (bucket.count > maxRequests) {
      safeError(
        res,
        req.promiseBondRequestId,
        429,
        "RATE_LIMITED",
        "Too many requests; retry after the rate-limit window"
      );
      return;
    }
    next();
  });

  app.use("/api/promisebond", express.json({ limit: bodyLimit, strict: true, type: "application/json" }));

  async function requireRepository() {
    try {
      const repository = await getRepository();
      if (!repository) throw new Error("not configured");
      return repository;
    } catch {
      throw new HttpError(503, "DATABASE_UNAVAILABLE", "PromiseBond persistence is unavailable");
    }
  }

  async function requireClient() {
    try {
      const client = await getReadClient();
      if (!client) throw new Error("not configured");
      return client;
    } catch {
      throw new HttpError(503, "BRADBURY_UNAVAILABLE", "Bradbury verification is unavailable");
    }
  }

  async function runBradburyOperation(work, milliseconds) {
    if (activeChainReads >= maxChainReads) {
      throw new HttpError(503, "BRADBURY_BUSY", "Bradbury verification is at capacity");
    }
    activeChainReads += 1;
    const operation = Promise.resolve().then(work);
    operation.then(
      () => { activeChainReads -= 1; },
      () => { activeChainReads -= 1; }
    );
    return timeout(operation, milliseconds);
  }

  app.get("/api/promisebond/health", async (req, res) => {
    const checks = { database: "unavailable", bradbury: "unavailable", worker: "unavailable" };
    try {
      if (isDatabaseConfigured()) {
        const repository = await getRepository();
        if (repository) {
          await timeout(Promise.resolve(repository.ping()), healthTimeout);
          checks.database = "ready";
        }
      } else {
        checks.database = "not_configured";
      }
    } catch {
      checks.database = "unavailable";
    }
    try {
      const client = await getReadClient();
      await runBradburyOperation(() => validateBradbury(client), healthTimeout);
      checks.bradbury = "ready";
    } catch {
      checks.bradbury = "unavailable";
    }
    checks.worker = typeof runWorkerOnce === "function" &&
      typeof cronSecret === "string" && Buffer.byteLength(cronSecret, "utf8") >= 24
      ? "ready"
      : "not_configured";
    const ready = checks.database === "ready" && checks.bradbury === "ready" &&
      checks.worker === "ready";
    res.status(ready ? 200 : 503).json({
      service: "promisebond",
      status: ready ? "ready" : "unavailable",
      network: { name: "bradbury", chainId: GENLAYER_BRADBURY_IDENTITY.chainId.toString(10) },
      checks,
      requestId: req.promiseBondRequestId
    });
  });

  app.post("/api/promisebond/evidence/preflight", async (req, res, next) => {
    try {
      if (!req.is("application/json")) {
        throw new HttpError(415, "CONTENT_TYPE_REQUIRED", "Content-Type must be application/json");
      }
      validateEvidencePreflightInput(req.body);
      if (activeEvidencePreflights >= maxEvidencePreflights) {
        throw new HttpError(503, "EVIDENCE_PREFLIGHT_BUSY", "Evidence preflight is at capacity");
      }
      activeEvidencePreflights += 1;
      try {
        const repository = await requireRepository();
        let quota;
        const consumedAt = new Date(Number(now()));
        try {
          if (typeof repository.consumeEvidencePreflightQuota !== "function") {
            throw new TypeError("evidence preflight quota repository is unavailable");
          }
          quota = await repository.consumeEvidencePreflightQuota({
            clientHash: evidenceClientHash(req),
            cost: EVIDENCE_SOURCE_COUNT,
            globalLimit: evidenceGlobalSourceLimit,
            clientLimit: evidenceClientSourceLimit,
            windowMs: evidenceQuotaWindow,
            consumedAt
          });
        } catch {
          throw new HttpError(503, "EVIDENCE_QUOTA_UNAVAILABLE", "Evidence preflight quota is unavailable");
        }
        if (!quota || typeof quota.allowed !== "boolean") {
          throw new HttpError(503, "EVIDENCE_QUOTA_UNAVAILABLE", "Evidence preflight quota is unavailable");
        }
        if (!quota.allowed) {
          const resetAt = new Date(quota?.resetAt).getTime();
          if (Number.isFinite(resetAt)) {
            res.setHeader("Retry-After", String(Math.max(1, Math.ceil((resetAt - consumedAt.getTime()) / 1_000))));
          }
          throw new HttpError(
            429,
            "EVIDENCE_PREFLIGHT_QUOTA_EXCEEDED",
            "Evidence preflight quota was exceeded; retry after the quota window"
          );
        }
        const result = await preflightEvidence(req.body);
        res.json({ ...result, requestId: req.promiseBondRequestId });
      } finally {
        activeEvidencePreflights -= 1;
      }
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/promisebond/contracts", async (req, res, next) => {
    try {
      if (!req.is("application/json")) {
        throw new HttpError(415, "CONTENT_TYPE_REQUIRED", "Content-Type must be application/json");
      }
      const { contractAddress } = parseRegistrationBody(req.body);
      const repository = await requireRepository();
      const client = await requireClient();
      let snapshot;
      try {
        snapshot = await runBradburyOperation(
          () => readFinalized({ client, contractAddress }),
          chainTimeout
        );
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof OperationTimeoutError) {
          throw new HttpError(504, "BRADBURY_TIMEOUT", "Bradbury finalized-state verification timed out");
        }
        if (!String(error?.message || "").startsWith("PromiseBond Bradbury client rejected:")) {
          throw new HttpError(503, "BRADBURY_UNAVAILABLE", "Bradbury verification is unavailable");
        }
        if (/Bradbury chain ID|Bradbury chain name|Bradbury native currency|consensus .* address/i.test(error.message)) {
          throw new HttpError(503, "BRADBURY_CONFIGURATION_REJECTED", "Bradbury verification is unavailable");
        }
        throw new HttpError(
          422,
          "FINALIZED_STATE_VERIFICATION_FAILED",
          "The address could not be verified as the reviewed PromiseBond release in finalized Bradbury state"
        );
      }
      const observedAt = new Date(Number(now()));
      const persisted = await repository.upsertFinalizedBond({ contractAddress, snapshot, observedAt });
      await repository.enqueueReconcileJob({ contractAddress, runAfter: observedAt });
      res.status(persisted.created ? 201 : 200).json({
        bond: persisted.bond,
        authoritativeSource: "genlayer_finalized_state",
        requestId: req.promiseBondRequestId
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/promisebond/contracts/:contractAddress", async (req, res, next) => {
    try {
      const contractAddress = normalizeContractAddress(req.params.contractAddress);
      const repository = await requireRepository();
      const bond = await repository.getBond(contractAddress);
      if (!bond) throw new HttpError(404, "CONTRACT_NOT_FOUND", "PromiseBond contract was not found");
      res.json({ bond, requestId: req.promiseBondRequestId });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/promisebond/contracts", async (req, res, next) => {
    try {
      const query = parsePublicListQuery(req.query);
      const repository = await requireRepository();
      const page = await repository.listBonds(query);
      res.json({ ...page, requestId: req.promiseBondRequestId });
    } catch (error) {
      next(error);
    }
  });

  async function reconcileBatch(req, res, next) {
    try {
      if (!secretMatches(req.headers.authorization, cronSecret)) {
        throw new HttpError(401, "UNAUTHORIZED", "Unauthorized");
      }
      if (typeof runWorkerOnce !== "function") {
        throw new HttpError(503, "WORKER_UNAVAILABLE", "PromiseBond worker is unavailable");
      }
      const repository = await requireRepository();
      const client = await requireClient();
      const startedAt = Number(now());
      const outcomes = [];
      for (let index = 0; index < maxWorkerJobs; index += 1) {
        if (index > 0 && Number(now()) - startedAt >= maxWorkerRuntime) break;
        const result = await runWorkerOnce({
          repository,
          client,
          workerId: `http:${createRequestId()}`
        });
        outcomes.push({
          status: result.status,
          ...(result.jobId ? { jobId: result.jobId } : {}),
          ...(result.contractAddress ? { contractAddress: result.contractAddress } : {})
        });
        if (result.status === "idle") break;
      }
      res.json({
        result: {
          status: "completed",
          jobsAttempted: outcomes.filter(({ status }) => status !== "idle").length,
          outcomes
        },
        requestId: req.promiseBondRequestId
      });
    } catch (error) {
      next(error);
    }
  }

  app.get("/api/promisebond/internal/reconcile-once", reconcileBatch);
  app.post("/api/promisebond/internal/reconcile-once", reconcileBatch);

  app.use("/api/promisebond", (req, res) => {
    safeError(res, req.promiseBondRequestId, 404, "NOT_FOUND", "PromiseBond API route was not found");
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof PromiseBondValidationError) {
      safeError(res, req.promiseBondRequestId, 400, "INVALID_REQUEST", error.message);
      return;
    }
    if (error instanceof EvidencePreflightError) {
      safeError(res, req.promiseBondRequestId, error.status, error.code, error.message);
      return;
    }
    if (error instanceof HttpError) {
      safeError(res, req.promiseBondRequestId, error.status, error.code, error.message);
      return;
    }
    if (error?.type === "entity.too.large") {
      safeError(res, req.promiseBondRequestId, 413, "PAYLOAD_TOO_LARGE", "JSON payload is too large");
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      safeError(res, req.promiseBondRequestId, 400, "INVALID_JSON", "JSON payload is invalid");
      return;
    }
    logger?.error?.("PromiseBond request failed", {
      method: req.method,
      path: req.path,
      requestId: req.promiseBondRequestId,
      errorName: error?.name || "Error"
    });
    safeError(
      res,
      req.promiseBondRequestId,
      500,
      "INTERNAL_ERROR",
      "PromiseBond request could not be completed"
    );
  });

  return app;
}
