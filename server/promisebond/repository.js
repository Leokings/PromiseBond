import { randomUUID } from "node:crypto";

import {
  encodeBondCursor,
  normalizeContractAddress,
  serializeFinalizedSnapshot,
  toPublicBond
} from "./validation.js";

const NETWORK = "bradbury";
const RECONCILE_JOB_TYPE = "reconcile_contract";
const EVIDENCE_PREFLIGHT_QUOTA_TYPE = "evidence_preflight";
const DEFAULT_MAX_ATTEMPTS = 8;

function isDuplicateKeyError(error) {
  return Number(error?.code) === 11_000;
}

function assertDatabase(database) {
  if (!database || typeof database.collection !== "function") {
    throw new TypeError("PromiseBond database is required");
  }
}

function exactDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid date`);
  return date;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function reconcileJobId(contractAddress) {
  return `reconcile:${NETWORK}:${normalizeContractAddress(contractAddress)}`;
}

export function createPromiseBondRepository({
  database,
  now = () => new Date(),
  createId = randomUUID,
  executeTransaction
}) {
  assertDatabase(database);
  const bonds = database.collection("promise_bonds");
  const jobs = database.collection("promisebond_jobs");
  const evidencePreflightQuotas = database.collection("promisebond_evidence_preflight_quotas");

  async function defaultExecuteTransaction(work) {
    if (!database.client || typeof database.client.startSession !== "function") {
      throw new TypeError("PromiseBond reconciliation requires MongoDB transaction support");
    }
    const session = database.client.startSession();
    try {
      return await session.withTransaction(() => work(session), {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
        maxCommitTimeMS: 8_000
      });
    } finally {
      await session.endSession();
    }
  }

  const runTransaction = executeTransaction || defaultExecuteTransaction;

  async function persistAuthoritative({ contractAddress, snapshot, observedAt, session }) {
    const address = normalizeContractAddress(contractAddress);
    const timestamp = exactDate(observedAt, "observedAt");
    const authoritative = serializeFinalizedSnapshot({
      contractAddress: address,
      observedAt: timestamp,
      snapshot
    });
    const filter = { network: NETWORK, contractAddress: address };
    const monotonicFilter = {
      ...filter,
      $or: [
        { stateRevision: { $exists: false } },
        { stateRevision: { $lte: authoritative.stateRevision } }
      ]
    };
    const update = {
      $set: { ...authoritative, updatedAt: timestamp },
      $setOnInsert: { createdAt: timestamp }
    };
    const sessionOptions = session ? { session } : {};
    let result;
    const existing = await bonds.findOne(filter, {
      ...sessionOptions,
      projection: { _id: 1, stateRevision: 1 }
    });
    if (existing) {
      result = await bonds.updateOne(monotonicFilter, { $set: update.$set }, sessionOptions);
    } else {
      try {
        result = await bonds.updateOne(filter, update, { upsert: true, ...sessionOptions });
      } catch (error) {
        // Concurrent registration may win the unique-key insert between the read and write. Only
        // apply this snapshot if it is not a regression in the irreversible contract state machine.
        if (!isDuplicateKeyError(error) || session) throw error;
        result = await bonds.updateOne(monotonicFilter, { $set: update.$set }, { upsert: false });
      }
    }
    const document = await bonds.findOne(filter, sessionOptions);
    if (!document) throw new Error("PromiseBond upsert did not return its persisted document");
    return {
      created: Number(result?.upsertedCount || 0) === 1,
      bond: toPublicBond(document)
    };
  }

  return Object.freeze({
    async ping() {
      if (typeof database.command !== "function") throw new TypeError("database cannot be pinged");
      await database.command({ ping: 1 });
      return true;
    },

    async upsertFinalizedBond({ contractAddress, snapshot, observedAt = now() }) {
      return persistAuthoritative({ contractAddress, snapshot, observedAt });
    },

    async getBond(contractAddress) {
      const address = normalizeContractAddress(contractAddress);
      return toPublicBond(await bonds.findOne({ network: NETWORK, contractAddress: address }));
    },

    async listBonds({ limit, cursor = null, creator = null }) {
      boundedInteger(limit, "limit", 1, 100);
      const baseFilter = {
        network: NETWORK,
        ...(creator ? { creatorAddress: normalizeContractAddress(creator, "creator") } : {})
      };
      const filter = cursor
        ? {
            ...baseFilter,
            $or: [
              { createdAt: { $lt: exactDate(cursor.createdAt, "cursor createdAt") } },
              {
                createdAt: exactDate(cursor.createdAt, "cursor createdAt"),
                contractAddress: { $gt: normalizeContractAddress(cursor.contractAddress) }
              }
            ]
          }
        : baseFilter;
      const documents = await bonds.find(filter)
        .sort({ createdAt: -1, contractAddress: 1 })
        .limit(limit + 1)
        .toArray();
      const hasMore = documents.length > limit;
      const page = hasMore ? documents.slice(0, limit) : documents;
      return {
        items: page.map(toPublicBond),
        nextCursor: hasMore && page.length > 0 ? encodeBondCursor(page[page.length - 1]) : null
      };
    },

    async consumeEvidencePreflightQuota({
      clientHash,
      cost,
      globalLimit,
      clientLimit,
      windowMs,
      consumedAt = now()
    }) {
      if (typeof clientHash !== "string" || !/^[0-9a-f]{64}$/.test(clientHash)) {
        throw new TypeError("clientHash must be a lowercase SHA-256 digest");
      }
      boundedInteger(cost, "cost", 1, 100);
      boundedInteger(globalLimit, "globalLimit", cost, 100_000);
      boundedInteger(clientLimit, "clientLimit", cost, globalLimit);
      boundedInteger(windowMs, "windowMs", 1_000, 3_600_000);
      const timestamp = exactDate(consumedAt, "consumedAt");
      const windowStartMs = Math.floor(timestamp.getTime() / windowMs) * windowMs;
      const windowStart = new Date(windowStartMs);
      const expiresAt = new Date(windowStartMs + windowMs);
      const bucketId = `evidence-preflight:${windowStartMs}`;
      const clientPath = `clients.${clientHash}`;

      try {
        await evidencePreflightQuotas.updateOne({ bucketId }, {
          $setOnInsert: {
            bucketId,
            type: EVIDENCE_PREFLIGHT_QUOTA_TYPE,
            windowStart,
            expiresAt,
            globalCost: 0,
            clients: {},
            createdAt: timestamp,
            updatedAt: timestamp
          }
        }, { upsert: true });
      } catch (error) {
        // A concurrent process may create the fixed-window document after our upsert filter runs.
        // Its unique bucket index makes that race harmless; consumption below is still one atomic update.
        if (!isDuplicateKeyError(error)) throw error;
      }

      const document = await evidencePreflightQuotas.findOneAndUpdate({
        bucketId,
        globalCost: { $lte: globalLimit - cost },
        $or: [
          { [clientPath]: { $exists: false } },
          { [clientPath]: { $lte: clientLimit - cost } }
        ]
      }, {
        $inc: { globalCost: cost, [clientPath]: cost },
        $set: { updatedAt: timestamp }
      }, {
        returnDocument: "after",
        projection: { globalCost: 1, [clientPath]: 1, expiresAt: 1 }
      });

      if (document) {
        const clientCost = Number(document.clients?.[clientHash] || 0);
        const globalCost = Number(document.globalCost || 0);
        return Object.freeze({
          allowed: true,
          clientRemaining: Math.max(0, clientLimit - clientCost),
          globalRemaining: Math.max(0, globalLimit - globalCost),
          resetAt: expiresAt
        });
      }

      const current = await evidencePreflightQuotas.findOne(
        { bucketId },
        { projection: { globalCost: 1, [clientPath]: 1, expiresAt: 1 } }
      );
      if (!current) {
        throw new Error("PromiseBond evidence preflight quota bucket disappeared during consumption");
      }
      const clientCost = Number(current.clients?.[clientHash] || 0);
      const globalCost = Number(current.globalCost || 0);
      return Object.freeze({
        allowed: false,
        scope: globalCost + cost > globalLimit ? "global" : "client",
        clientRemaining: Math.max(0, clientLimit - clientCost),
        globalRemaining: Math.max(0, globalLimit - globalCost),
        resetAt: expiresAt
      });
    },

    async enqueueReconcileJob({ contractAddress, priority = 0, runAfter = now() }) {
      const address = normalizeContractAddress(contractAddress);
      const timestamp = exactDate(now(), "now");
      const scheduledFor = exactDate(runAfter, "runAfter");
      boundedInteger(priority, "priority", -100, 100);
      const jobId = reconcileJobId(address);
      const insert = {
        $setOnInsert: {
          jobId,
          type: RECONCILE_JOB_TYPE,
          network: NETWORK,
          contractAddress: address,
          status: "queued",
          priority,
          attempts: 0,
          maxAttempts: DEFAULT_MAX_ATTEMPTS,
          runAfter: scheduledFor,
          leaseOwner: null,
          leaseExpiresAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          correlationId: createId()
        }
      };
      try {
        await jobs.updateOne({ jobId }, insert, { upsert: true });
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }
      // An explicit, successfully verified registration is the only anonymous path that can
      // revive a job which exhausted its retries. Active leases and scheduled retries remain
      // untouched, preserving their atomic ownership and backoff.
      await jobs.updateOne({ jobId, status: { $in: ["dead", "completed"] } }, {
        $set: {
          status: "queued",
          attempts: 0,
          runAfter: scheduledFor,
          lastErrorCode: null,
          leaseOwner: null,
          leasedAt: null,
          leaseExpiresAt: null,
          updatedAt: timestamp
        }
      });
      return { jobId };
    },

    async leaseNextReconcileJob({ leaseOwner, leaseMs = 30_000, leasedAt = now() }) {
      if (typeof leaseOwner !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(leaseOwner)) {
        throw new TypeError("leaseOwner is invalid");
      }
      boundedInteger(leaseMs, "leaseMs", 1_000, 300_000);
      const timestamp = exactDate(leasedAt, "leasedAt");
      const leaseExpiresAt = new Date(timestamp.getTime() + leaseMs);
      await jobs.updateMany({
        type: RECONCILE_JOB_TYPE,
        network: NETWORK,
        status: "leased",
        attempts: { $gte: DEFAULT_MAX_ATTEMPTS },
        leaseExpiresAt: { $lte: timestamp }
      }, {
        $set: {
          status: "dead",
          runAfter: timestamp,
          lastFailedAt: timestamp,
          lastErrorCode: "LEASE_EXPIRED_AT_MAX_ATTEMPTS",
          leaseOwner: null,
          leasedAt: null,
          leaseExpiresAt: null,
          updatedAt: timestamp
        }
      });
      return jobs.findOneAndUpdate({
        type: RECONCILE_JOB_TYPE,
        network: NETWORK,
        attempts: { $lt: DEFAULT_MAX_ATTEMPTS },
        $or: [
          { status: { $in: ["queued", "retry"] }, runAfter: { $lte: timestamp } },
          { status: "leased", leaseExpiresAt: { $lte: timestamp } }
        ]
      }, {
        $set: {
          status: "leased",
          leaseOwner,
          leasedAt: timestamp,
          leaseExpiresAt,
          updatedAt: timestamp
        },
        $inc: { attempts: 1 }
      }, {
        sort: { priority: -1, runAfter: 1, createdAt: 1 },
        returnDocument: "after"
      });
    },

    async completeReconcileJob({
      jobId,
      leaseOwner,
      completedAt = now(),
      nextRunAfter
    }) {
      const timestamp = exactDate(completedAt, "completedAt");
      const scheduledFor = exactDate(nextRunAfter, "nextRunAfter");
      const result = await jobs.updateOne({
        jobId,
        status: "leased",
        leaseOwner,
        leaseExpiresAt: { $gt: timestamp }
      }, {
        $set: {
          status: "queued",
          runAfter: scheduledFor,
          attempts: 0,
          lastCompletedAt: timestamp,
          lastErrorCode: null,
          leaseOwner: null,
          leasedAt: null,
          leaseExpiresAt: null,
          updatedAt: timestamp
        }
      });
      return Number(result?.modifiedCount || 0) === 1;
    },

    async persistReconciledLease({
      jobId,
      leaseOwner,
      contractAddress,
      snapshot,
      reconciledAt = now(),
      nextRunAfter = null
    }) {
      if (typeof jobId !== "string" || jobId !== reconcileJobId(contractAddress)) {
        throw new TypeError("jobId does not match the PromiseBond contract");
      }
      if (typeof leaseOwner !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(leaseOwner)) {
        throw new TypeError("leaseOwner is invalid");
      }
      const address = normalizeContractAddress(contractAddress);
      const timestamp = exactDate(reconciledAt, "reconciledAt");
      const scheduledFor = nextRunAfter === null ? null : exactDate(nextRunAfter, "nextRunAfter");

      return runTransaction(async (session) => {
        const leaseFilter = {
          jobId,
          type: RECONCILE_JOB_TYPE,
          network: NETWORK,
          contractAddress: address,
          status: "leased",
          leaseOwner,
          leaseExpiresAt: { $gt: timestamp }
        };
        const lease = await jobs.findOne(leaseFilter, { session, projection: { _id: 1 } });
        if (!lease) return { committed: false, bond: null };

        const persisted = await persistAuthoritative({
          contractAddress: address,
          snapshot,
          observedAt: timestamp,
          session
        });
        const completion = await jobs.updateOne(leaseFilter, {
          $set: {
            status: scheduledFor ? "queued" : "completed",
            runAfter: scheduledFor,
            attempts: 0,
            lastCompletedAt: timestamp,
            lastErrorCode: null,
            leaseOwner: null,
            leasedAt: null,
            leaseExpiresAt: null,
            updatedAt: timestamp
          }
        }, { session });
        if (Number(completion?.modifiedCount || 0) !== 1) {
          throw new Error("PromiseBond reconciliation lease changed during commit");
        }
        return { committed: true, bond: persisted.bond };
      });
    },

    async retryReconcileJob({
      jobId,
      leaseOwner,
      attempt,
      failedAt = now(),
      errorCode = "RECONCILE_FAILED",
      retryAfter
    }) {
      boundedInteger(attempt, "attempt", 1, DEFAULT_MAX_ATTEMPTS);
      if (typeof errorCode !== "string" || !/^[A-Z0-9_]{1,64}$/.test(errorCode)) {
        throw new TypeError("errorCode is invalid");
      }
      const timestamp = exactDate(failedAt, "failedAt");
      const dead = attempt >= DEFAULT_MAX_ATTEMPTS;
      const scheduledFor = dead ? timestamp : exactDate(retryAfter, "retryAfter");
      const result = await jobs.updateOne({ jobId, status: "leased", leaseOwner }, {
        $set: {
          status: dead ? "dead" : "retry",
          runAfter: scheduledFor,
          lastFailedAt: timestamp,
          lastErrorCode: errorCode,
          leaseOwner: null,
          leasedAt: null,
          leaseExpiresAt: null,
          updatedAt: timestamp
        }
      });
      return Number(result?.modifiedCount || 0) === 1;
    }
  });
}
