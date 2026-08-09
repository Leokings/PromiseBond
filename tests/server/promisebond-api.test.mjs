import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";

import { createPromiseBondApp } from "../../server/promisebond/app.js";
import { createPromiseBondRepository } from "../../server/promisebond/repository.js";
import { encodeBondCursor } from "../../server/promisebond/validation.js";
import { runPromiseBondWorkerOnce } from "../../server/promisebond/worker.js";

const CONTRACT = "0x1000000000000000000000000000000000000001";
const CREATOR = "0x2000000000000000000000000000000000000002";
const BENEFICIARY = "0x3000000000000000000000000000000000000003";
const NOW = new Date("2026-08-09T20:00:00.000Z");
const BOND_AMOUNT = 1_250_000_000_000_000_000n;

test("serverless runtime has no local environment-file dependency graph", () => {
  const source = fs.readFileSync("server/promisebond/runtime.js", "utf8");
  assert.doesNotMatch(source, /from\s+["']dotenv["']/);
  assert.doesNotMatch(source, /node:(?:fs|path)/);
  assert.doesNotMatch(source, /config[\\/]promisebond|\.env\.local|\.env\.promisebond/);
});

function finalizedSnapshot(overrides = {}) {
  return {
    terms: {
      policyVersion: "promisebond.native-gen.v1",
      creator: CREATOR,
      beneficiary: BENEFICIARY,
      bondAmountWei: BOND_AMOUNT,
      fundingDeadline: 1_800_000_000n,
      deadline: 1_800_086_400n,
      promiseText: "I will publish the audited release before the deadline.",
      successCriteria: "The approved release page shows the artifact.",
      failureCriteria: "No qualifying artifact is published by the deadline.",
      evidenceUrlsJson: '["https://example.com/releases"]'
    },
    state: {
      settlement: "LOCKED",
      outcome: "NONE",
      bondAmountWei: BOND_AMOUNT,
      lockedAmountWei: BOND_AMOUNT,
      fundedAt: 1_799_900_000n,
      resolvedAt: 0n,
      settlementQueuedAt: 0n,
      payoutRecipient: "0x0000000000000000000000000000000000000000",
      reasoning: "",
      decisiveEvidence: ""
    },
    contractBalanceWei: BOND_AMOUNT,
    readVariant: "latest-final",
    ...overrides
  };
}

function publicBond(address = CONTRACT) {
  return {
    network: "bradbury",
    chainId: "4221",
    contractAddress: address,
    sourceKeccak256: `0x${"11".repeat(32)}`,
    creatorAddress: CREATOR,
    beneficiaryAddress: BENEFICIARY,
    status: "LOCKED",
    outcome: "NONE",
    bondAmountWei: BOND_AMOUNT.toString(),
    fundingDeadline: "1800000000",
    deadline: "1800086400",
    terms: {},
    state: {},
    contractBalanceWei: BOND_AMOUNT.toString(),
    finalizedReadVariant: "latest-final",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    finalizedStateObservedAt: NOW.toISOString()
  };
}

function fakeRepository() {
  const stored = new Map();
  const calls = [];
  return {
    calls,
    stored,
    async ping() {
      calls.push(["ping"]);
    },
    async upsertFinalizedBond(input) {
      calls.push(["upsertFinalizedBond", input]);
      const created = !stored.has(input.contractAddress);
      const bond = publicBond(input.contractAddress);
      stored.set(input.contractAddress, bond);
      return { created, bond };
    },
    async enqueueReconcileJob(input) {
      calls.push(["enqueueReconcileJob", input]);
      return { jobId: `reconcile:bradbury:${input.contractAddress}` };
    },
    async getBond(address) {
      calls.push(["getBond", address]);
      return stored.get(address) || null;
    },
    async listBonds(query) {
      calls.push(["listBonds", query]);
      return { items: [...stored.values()].slice(0, query.limit), nextCursor: null };
    }
  };
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })
  };
}

let api;
let apiRepository;
let apiReadCalls;

before(async () => {
  apiRepository = fakeRepository();
  apiReadCalls = [];
  let requestId = 0;
  const app = createPromiseBondApp({
    getRepository: async () => apiRepository,
    getReadClient: async () => ({ chain: { id: 4_221 } }),
    isDatabaseConfigured: () => true,
    validateBradbury: async () => {},
    readFinalized: async (input) => {
      apiReadCalls.push(input);
      return finalizedSnapshot();
    },
    runWorkerOnce: async () => ({ status: "idle" }),
    cronSecret: "this-is-a-long-promisebond-cron-secret",
    createRequestId: () => `request-${++requestId}`,
    now: () => NOW.getTime(),
    rateLimitMax: 100,
    logger: { error() {} }
  });
  api = await listen(app);
});

after(async () => {
  await api.close();
});

test("anonymous registration accepts only an address and rebuilds the record from finalized state", async () => {
  const first = await fetch(`${api.baseUrl}/api/promisebond/contracts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contractAddress: CONTRACT.toUpperCase().replace("0X", "0x") })
  });
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.equal(firstBody.bond.contractAddress, CONTRACT);
  assert.equal(firstBody.authoritativeSource, "genlayer_finalized_state");
  assert.equal(apiReadCalls.length, 1);
  assert.equal(apiReadCalls[0].contractAddress, CONTRACT);
  const upsert = apiRepository.calls.find(([name]) => name === "upsertFinalizedBond")[1];
  assert.equal(upsert.snapshot.terms.bondAmountWei, BOND_AMOUNT);

  const second = await fetch(`${api.baseUrl}/api/promisebond/contracts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contractAddress: CONTRACT })
  });
  assert.equal(second.status, 200);
  assert.equal(apiRepository.stored.size, 1);

  const injected = await fetch(`${api.baseUrl}/api/promisebond/contracts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contractAddress: CONTRACT, bondAmountWei: "999999999" })
  });
  assert.equal(injected.status, 400);
  assert.equal((await injected.json()).error.code, "INVALID_REQUEST");
  assert.equal(apiReadCalls.length, 2);
});

test("registration separates dependency failure from a proven contract rejection without leaking details", async () => {
  const repository = fakeRepository();
  const app = createPromiseBondApp({
    getRepository: async () => repository,
    getReadClient: async () => ({}),
    readFinalized: async () => { throw new Error("RPC contained credentials mongodb://secret"); },
    createRequestId: () => "safe-request-id",
    logger: { error() {} }
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/promisebond/contracts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contractAddress: CONTRACT })
    });
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.doesNotMatch(text, /mongodb|secret|RPC contained/i);
    assert.equal(repository.calls.some(([name]) => name === "upsertFinalizedBond"), false);
  } finally {
    await server.close();
  }

  const rejectedRepository = fakeRepository();
  const rejectedApp = createPromiseBondApp({
    getRepository: async () => rejectedRepository,
    getReadClient: async () => ({}),
    readFinalized: async () => {
      throw new Error("PromiseBond Bradbury client rejected: deployed PromiseBond source hash does not match");
    },
    createRequestId: () => "rejected-contract-request",
    logger: { error() {} }
  });
  const rejectedServer = await listen(rejectedApp);
  try {
    const response = await fetch(`${rejectedServer.baseUrl}/api/promisebond/contracts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contractAddress: CONTRACT })
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, "FINALIZED_STATE_VERIFICATION_FAILED");
  } finally {
    await rejectedServer.close();
  }
});

test("public reads have strict address and pagination validation", async () => {
  const found = await fetch(`${api.baseUrl}/api/promisebond/contracts/${CONTRACT}`);
  assert.equal(found.status, 200);
  assert.equal((await found.json()).bond.contractAddress, CONTRACT);

  const invalidAddress = await fetch(`${api.baseUrl}/api/promisebond/contracts/0x1234`);
  assert.equal(invalidAddress.status, 400);

  const unknownQuery = await fetch(`${api.baseUrl}/api/promisebond/contracts?status=LOCKED`);
  assert.equal(unknownQuery.status, 400);

  const duplicateLimit = await fetch(`${api.baseUrl}/api/promisebond/contracts?limit=1&limit=2`);
  assert.equal(duplicateLimit.status, 400);

  const invalidLimit = await fetch(`${api.baseUrl}/api/promisebond/contracts?limit=101`);
  assert.equal(invalidLimit.status, 400);

  const cursor = encodeBondCursor({ createdAt: NOW, contractAddress: CONTRACT });
  const page = await fetch(
    `${api.baseUrl}/api/promisebond/contracts?limit=1&cursor=${cursor}&creator=${CREATOR.toUpperCase().replace("0X", "0x")}`
  );
  assert.equal(page.status, 200);
  const listCall = apiRepository.calls.filter(([name]) => name === "listBonds").at(-1)[1];
  assert.equal(listCall.limit, 1);
  assert.equal(listCall.creator, CREATOR);
  assert.equal(listCall.cursor.contractAddress, CONTRACT);
  assert.equal(listCall.cursor.createdAt.toISOString(), NOW.toISOString());

  const invalidCreator = await fetch(`${api.baseUrl}/api/promisebond/contracts?creator=0x1234`);
  assert.equal(invalidCreator.status, 400);

  const duplicateCreator = await fetch(
    `${api.baseUrl}/api/promisebond/contracts?creator=${CREATOR}&creator=${BENEFICIARY}`
  );
  assert.equal(duplicateCreator.status, 400);
});

test("health reports readiness without database names, URIs, or secrets", async () => {
  const response = await fetch(`${api.baseUrl}/api/promisebond/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.checks, { database: "ready", bradbury: "ready", worker: "ready" });
  assert.deepEqual(body.network, { name: "bradbury", chainId: "4221" });
  assert.doesNotMatch(JSON.stringify(body), /mongodb|uri|credential|secret|promisebond_staging/i);
});

test("health is not ready when the authenticated reconciliation worker is not configured", async () => {
  const repository = fakeRepository();
  const app = createPromiseBondApp({
    getRepository: async () => repository,
    getReadClient: async () => ({}),
    isDatabaseConfigured: () => true,
    validateBradbury: async () => {},
    createRequestId: () => "worker-readiness-request",
    logger: { error() {} }
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/promisebond/health`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).checks.worker, "not_configured");
  } finally {
    await server.close();
  }
});

test("the Vercel-compatible GET worker endpoint is authenticated and drains a bounded batch", async () => {
  const unauthorized = await fetch(`${api.baseUrl}/api/promisebond/internal/reconcile-once`);
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error.code, "UNAUTHORIZED");

  const authorized = await fetch(`${api.baseUrl}/api/promisebond/internal/reconcile-once`, {
    headers: { authorization: "Bearer this-is-a-long-promisebond-cron-secret" }
  });
  assert.equal(authorized.status, 200);
  const body = await authorized.json();
  assert.equal(body.result.status, "completed");
  assert.equal(body.result.jobsAttempted, 0);
  assert.deepEqual(body.result.outcomes, [{ status: "idle" }]);
});

test("a cron invocation cannot become an endless worker loop", async () => {
  const repository = fakeRepository();
  let workerCalls = 0;
  const app = createPromiseBondApp({
    getRepository: async () => repository,
    getReadClient: async () => ({}),
    runWorkerOnce: async () => {
      workerCalls += 1;
      return { status: "reconciled", jobId: `job-${workerCalls}`, contractAddress: CONTRACT };
    },
    cronSecret: "this-is-another-long-cron-secret",
    workerBatchSize: 3,
    now: () => NOW.getTime(),
    createRequestId: () => `bounded-worker-${workerCalls}`,
    logger: { error() {} }
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/promisebond/internal/reconcile-once`, {
      headers: { authorization: "Bearer this-is-another-long-cron-secret" }
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.jobsAttempted, 3);
    assert.equal(workerCalls, 3);
  } finally {
    await server.close();
  }
});

test("payload and per-client request rates are bounded", async () => {
  const repository = fakeRepository();
  const app = createPromiseBondApp({
    getRepository: async () => repository,
    getReadClient: async () => ({}),
    readFinalized: async () => finalizedSnapshot(),
    createRequestId: () => "bounded-request",
    bodyLimitBytes: 256,
    rateLimitMax: 2,
    logger: { error() {} }
  });
  const server = await listen(app);
  try {
    const tooLarge = await fetch(`${server.baseUrl}/api/promisebond/contracts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contractAddress: CONTRACT, padding: "x".repeat(512) })
    });
    assert.equal(tooLarge.status, 413);

    const second = await fetch(`${server.baseUrl}/api/promisebond/contracts`);
    assert.equal(second.status, 200);
    const limited = await fetch(`${server.baseUrl}/api/promisebond/contracts`);
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, "RATE_LIMITED");
  } finally {
    await server.close();
  }
});

test("forwarded client addresses are ignored unless one trusted proxy hop is explicitly enabled", async () => {
  async function exercise(trustProxy) {
    const repository = fakeRepository();
    const app = createPromiseBondApp({
      getRepository: async () => repository,
      getReadClient: async () => ({}),
      createRequestId: () => "proxy-rate-request",
      trustProxy,
      rateLimitMax: 1,
      logger: { error() {} }
    });
    const server = await listen(app);
    try {
      const first = await fetch(`${server.baseUrl}/api/promisebond/contracts`, {
        headers: { "x-forwarded-for": "198.51.100.10" }
      });
      const second = await fetch(`${server.baseUrl}/api/promisebond/contracts`, {
        headers: { "x-forwarded-for": "198.51.100.11" }
      });
      return [first.status, second.status];
    } finally {
      await server.close();
    }
  }

  assert.deepEqual(await exercise(false), [200, 429]);
  assert.deepEqual(await exercise(true), [200, 200]);
});

test("repository stores all finalized bigint fields as decimal strings", async () => {
  let persisted;
  const collection = {
    async updateOne(filter, update) {
      if (
        filter.$or && persisted &&
        Number(persisted.stateRevision) > Number(update.$set.stateRevision)
      ) {
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      }
      persisted = { ...filter, ...update.$setOnInsert, ...update.$set };
      return { upsertedCount: 1 };
    },
    async findOne() {
      return persisted;
    }
  };
  const database = {
    collection(name) {
      if (name === "promise_bonds") return collection;
      return { async updateOne() {} };
    }
  };
  const repository = createPromiseBondRepository({ database, now: () => NOW });
  const result = await repository.upsertFinalizedBond({
    contractAddress: CONTRACT,
    snapshot: finalizedSnapshot(),
    observedAt: NOW
  });
  assert.equal(result.created, true);
  assert.equal(persisted.bondAmountWei, BOND_AMOUNT.toString());
  assert.equal(persisted.terms.deadline, "1800086400");
  assert.equal(persisted.state.lockedAmountWei, BOND_AMOUNT.toString());
  assert.equal(persisted.contractBalanceWei, BOND_AMOUNT.toString());
  assert.doesNotThrow(() => JSON.stringify(result.bond));
  assert.doesNotMatch(JSON.stringify(persisted), /\[object BigInt\]/);

  const stale = finalizedSnapshot({
    state: {
      ...finalizedSnapshot().state,
      settlement: "UNFUNDED",
      lockedAmountWei: 0n,
      fundedAt: 0n
    },
    contractBalanceWei: 0n
  });
  const staleResult = await repository.upsertFinalizedBond({
    contractAddress: CONTRACT,
    snapshot: stale,
    observedAt: new Date(NOW.getTime() + 1_000)
  });
  assert.equal(staleResult.bond.status, "LOCKED");
  assert.equal(persisted.stateRevision, 1);

  await assert.rejects(
    repository.upsertFinalizedBond({
      contractAddress: CONTRACT,
      snapshot: finalizedSnapshot({ readVariant: "latest-nonfinal" }),
      observedAt: NOW
    }),
    /exact latest-final read variant/
  );
});

test("job leasing and completion are atomic and lease-owner guarded", async () => {
  const calls = [];
  const jobs = {
    async updateMany(filter, update) {
      calls.push(["updateMany", filter, update]);
      return { modifiedCount: 0 };
    },
    async updateOne(filter, update, options) {
      calls.push(["updateOne", filter, update, options]);
      return { modifiedCount: 1 };
    },
    async findOneAndUpdate(filter, update, options) {
      calls.push(["findOneAndUpdate", filter, update, options]);
      return {
        jobId: `reconcile:bradbury:${CONTRACT}`,
        contractAddress: CONTRACT,
        status: "leased",
        attempts: 1
      };
    }
  };
  const database = {
    collection(name) {
      return name === "promisebond_jobs" ? jobs : {};
    }
  };
  const repository = createPromiseBondRepository({ database, now: () => NOW, createId: () => "job-correlation" });
  await repository.enqueueReconcileJob({ contractAddress: CONTRACT });
  const revival = calls.find(([, filter]) => filter?.status?.$in);
  assert.deepEqual(revival[1], {
    jobId: `reconcile:bradbury:${CONTRACT}`,
    status: { $in: ["dead", "completed"] }
  });
  assert.equal(revival[2].$set.status, "queued");
  assert.equal(revival[2].$set.attempts, 0);
  const job = await repository.leaseNextReconcileJob({
    leaseOwner: "worker-1",
    leaseMs: 30_000,
    leasedAt: NOW
  });
  assert.equal(job.contractAddress, CONTRACT);
  const leaseCall = calls.find(([name]) => name === "findOneAndUpdate");
  assert.equal(leaseCall[1].type, "reconcile_contract");
  assert.deepEqual(leaseCall[2].$inc, { attempts: 1 });
  assert.equal(leaseCall[3].returnDocument, "after");
  assert.deepEqual(leaseCall[3].sort, { priority: -1, runAfter: 1, createdAt: 1 });
  const expiredMaxAttemptReaper = calls.find(([name]) => name === "updateMany");
  assert.equal(expiredMaxAttemptReaper[1].status, "leased");
  assert.deepEqual(expiredMaxAttemptReaper[1].attempts, { $gte: 8 });
  assert.equal(expiredMaxAttemptReaper[2].$set.status, "dead");

  await repository.completeReconcileJob({
    jobId: job.jobId,
    leaseOwner: "worker-1",
    completedAt: NOW,
    nextRunAfter: new Date(NOW.getTime() + 60_000)
  });
  const completion = calls.at(-1);
  assert.equal(completion[1].jobId, job.jobId);
  assert.equal(completion[1].status, "leased");
  assert.equal(completion[1].leaseOwner, "worker-1");
  assert.ok(completion[1].leaseExpiresAt.$gt instanceof Date);
  assert.equal(completion[2].$set.status, "queued");
  assert.equal(completion[2].$set.attempts, 0);
});

test("a finalized snapshot and its lease completion commit in one owner-and-expiry-guarded transaction", async () => {
  let bondDocument;
  let bondWrites = 0;
  let leaseAvailable = true;
  const transactionSession = { id: "fake-session" };
  const bonds = {
    async findOne() {
      return bondDocument || null;
    },
    async updateOne(filter, update) {
      bondWrites += 1;
      bondDocument = { ...filter, ...update.$setOnInsert, ...update.$set };
      return { upsertedCount: 1, modifiedCount: 1 };
    }
  };
  const jobs = {
    async findOne(filter, options) {
      assert.equal(options.session, transactionSession);
      assert.equal(filter.leaseOwner, "worker-transaction");
      assert.ok(filter.leaseExpiresAt.$gt instanceof Date);
      return leaseAvailable ? { _id: "leased-job" } : null;
    },
    async updateOne(filter, update, options) {
      assert.equal(options.session, transactionSession);
      assert.equal(filter.leaseOwner, "worker-transaction");
      assert.equal(update.$set.status, "queued");
      return { modifiedCount: 1 };
    }
  };
  const database = {
    collection(name) {
      return name === "promise_bonds" ? bonds : jobs;
    }
  };
  let transactions = 0;
  const repository = createPromiseBondRepository({
    database,
    now: () => NOW,
    executeTransaction: async (work) => {
      transactions += 1;
      return work(transactionSession);
    }
  });
  const jobId = `reconcile:bradbury:${CONTRACT}`;
  const committed = await repository.persistReconciledLease({
    jobId,
    leaseOwner: "worker-transaction",
    contractAddress: CONTRACT,
    snapshot: finalizedSnapshot(),
    reconciledAt: NOW,
    nextRunAfter: new Date(NOW.getTime() + 60_000)
  });
  assert.equal(committed.committed, true);
  assert.equal(committed.bond.contractAddress, CONTRACT);
  assert.equal(transactions, 1);
  assert.equal(bondWrites, 1);

  leaseAvailable = false;
  const writesBeforeLostLease = bondWrites;
  const lost = await repository.persistReconciledLease({
    jobId,
    leaseOwner: "worker-transaction",
    contractAddress: CONTRACT,
    snapshot: finalizedSnapshot(),
    reconciledAt: NOW,
    nextRunAfter: new Date(NOW.getTime() + 60_000)
  });
  assert.deepEqual(lost, { committed: false, bond: null });
  assert.equal(bondWrites, writesBeforeLostLease);
});

test("one worker invocation validates Bradbury, processes at most one lease, and schedules retry safely", async (t) => {
  await t.test("successful reconciliation", async () => {
    const calls = [];
    const repository = {
      async leaseNextReconcileJob(input) {
        calls.push(["lease", input]);
        return { jobId: "job-1", contractAddress: CONTRACT, attempts: 1 };
      },
      async persistReconciledLease(input) {
        calls.push(["commit", input]);
        return { committed: true, bond: publicBond() };
      },
      async retryReconcileJob(input) {
        calls.push(["retry", input]);
        return true;
      }
    };
    let validations = 0;
    const result = await runPromiseBondWorkerOnce({
      repository,
      client: {},
      workerId: "worker-1",
      now: () => NOW,
      assertBradbury: async () => { validations += 1; },
      readFinalized: async () => finalizedSnapshot()
    });
    assert.equal(result.status, "reconciled");
    assert.equal(validations, 1);
    assert.equal(calls.filter(([name]) => name === "lease").length, 1);
    assert.equal(calls.filter(([name]) => name === "commit").length, 1);
    assert.equal(calls.some(([name]) => name === "retry"), false);
  });

  await t.test("failed reconciliation", async () => {
    let retry;
    const repository = {
      async leaseNextReconcileJob() {
        return { jobId: "job-2", contractAddress: CONTRACT, attempts: 2 };
      },
      async retryReconcileJob(input) {
        retry = input;
        return true;
      }
    };
    const result = await runPromiseBondWorkerOnce({
      repository,
      client: {},
      workerId: "worker-2",
      now: () => NOW,
      assertBradbury: async () => {},
      readFinalized: async () => { throw new Error("mongodb://credential@host"); }
    });
    assert.equal(result.status, "retry_scheduled");
    assert.equal(retry.errorCode, "BRADBURY_RECONCILE_FAILED");
    assert.equal("error" in retry, false);
  });
});
