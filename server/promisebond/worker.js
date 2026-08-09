import {
  assertPromiseBondBradburyClient,
  readFinalizedPromiseBond
} from "../../shared/promisebond/bradbury-native.js";
import { normalizeContractAddress } from "./validation.js";

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function timeout(promise, milliseconds) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Bradbury read timed out")), milliseconds);
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

export async function runPromiseBondWorkerOnce({
  repository,
  client,
  workerId,
  now = () => new Date(),
  leaseMs = 30_000,
  readTimeoutMs = 20_000,
  reconcileIntervalMs = 60_000,
  retryBaseMs = 5_000,
  assertBradbury = assertPromiseBondBradburyClient,
  readFinalized = readFinalizedPromiseBond
}) {
  if (!repository) throw new TypeError("PromiseBond repository is required");
  if (!client) throw new TypeError("PromiseBond Bradbury read client is required");
  if (typeof workerId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(workerId)) {
    throw new TypeError("workerId is invalid");
  }
  boundedInteger(leaseMs, "leaseMs", 2_000, 300_000);
  boundedInteger(readTimeoutMs, "readTimeoutMs", 250, 120_000);
  if (readTimeoutMs > leaseMs - 1_000) {
    throw new TypeError("readTimeoutMs must leave at least one second in the reconciliation lease");
  }
  boundedInteger(reconcileIntervalMs, "reconcileIntervalMs", 5_000, 86_400_000);
  boundedInteger(retryBaseMs, "retryBaseMs", 1_000, 300_000);

  // Validate the live network even when the queue is empty. A green worker run therefore means
  // both its database lease path and its Bradbury client target are usable.
  await timeout(Promise.resolve(assertBradbury(client)), readTimeoutMs);
  const leasedAt = new Date(now());
  const job = await repository.leaseNextReconcileJob({
    leaseOwner: workerId,
    leaseMs,
    leasedAt
  });
  if (!job) return { status: "idle" };

  try {
    const contractAddress = normalizeContractAddress(job.contractAddress);
    const snapshot = await timeout(
      Promise.resolve(readFinalized({ client, contractAddress })),
      readTimeoutMs
    );
    const reconciledAt = new Date(now());
    const terminal = snapshot.state?.settlement === "EXPIRED" ||
      snapshot.state?.settlement === "PAYOUT_QUEUED";
    const persisted = await repository.persistReconciledLease({
      jobId: job.jobId,
      leaseOwner: workerId,
      contractAddress,
      snapshot,
      reconciledAt,
      nextRunAfter: terminal ? null : new Date(reconciledAt.getTime() + reconcileIntervalMs)
    });
    return {
      status: persisted.committed ? "reconciled" : "lease_lost",
      jobId: job.jobId,
      contractAddress,
      bond: persisted.bond
    };
  } catch {
    const failedAt = new Date(now());
    const attempt = Number(job.attempts);
    const exponent = Math.max(0, Math.min(6, attempt - 1));
    const retryDelay = Math.min(300_000, retryBaseMs * (2 ** exponent));
    const retained = await repository.retryReconcileJob({
      jobId: job.jobId,
      leaseOwner: workerId,
      attempt,
      failedAt,
      retryAfter: new Date(failedAt.getTime() + retryDelay),
      errorCode: "BRADBURY_RECONCILE_FAILED"
    });
    return {
      status: retained ? (attempt >= 8 ? "dead" : "retry_scheduled") : "lease_lost",
      jobId: job.jobId
    };
  }
}
