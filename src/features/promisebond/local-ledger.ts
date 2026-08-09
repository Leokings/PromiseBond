import type { TransactionHash } from "genlayer-js/types";
import type { Address } from "viem";

export const PROMISEBOND_LOCAL_LEDGER_KEY = "promisebond:bradbury:ledger:v1";
const MAX_LOCAL_RECORDS = 50;

export type PromiseBondFormSnapshot = {
  beneficiary: string;
  evidenceUrls: string;
  failureCriteria: string;
  fundingDeadline: string;
  promise: string;
  resolutionDeadline: string;
  stake: string;
  successCriteria: string;
};

export type PromiseBondOperationStage =
  | "prepared"
  | "deployment_submitted"
  | "deployment_failed"
  | "deployed_unfunded"
  | "funding_submitted"
  | "funded";

export type PromiseBondLocalRecord = {
  amountWei: string;
  chainId: 4221;
  contractAddress?: Address;
  createdAt: string;
  creator: Address;
  deploymentTxId?: TransactionHash;
  draft: PromiseBondFormSnapshot;
  evidenceUrls: string[];
  fundingDeadlineSeconds: string;
  fundingTxId?: TransactionHash;
  id: string;
  lastFailedTransaction?: {
    failedAt: string;
    kind: "deployment" | "funding" | "action";
    transactionId: TransactionHash;
  };
  lastAction?: {
    functionName: "resolve" | "expire_unfunded" | "refund_unresolved" | "refund_stale";
    transactionId: TransactionHash;
  };
  network: "bradbury";
  resolutionDeadlineSeconds: string;
  pendingAction?: {
    functionName: "resolve" | "expire_unfunded" | "refund_unresolved" | "refund_stale";
    transactionId: TransactionHash;
  };
  stage: PromiseBondOperationStage;
  updatedAt: string;
};

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFormSnapshot(value: unknown): value is PromiseBondFormSnapshot {
  if (!isStringRecord(value)) return false;
  return [
    "beneficiary",
    "evidenceUrls",
    "failureCriteria",
    "fundingDeadline",
    "promise",
    "resolutionDeadline",
    "stake",
    "successCriteria"
  ].every((field) => typeof value[field] === "string");
}

function isTransactionHash(value: unknown): value is TransactionHash {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isAddress(value: unknown): value is Address {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

function isLocalRecord(value: unknown): value is PromiseBondLocalRecord {
  if (!isStringRecord(value)) return false;
  const stage = value.stage;
  const validStage = stage === "prepared"
    || stage === "deployment_submitted"
    || stage === "deployment_failed"
    || stage === "deployed_unfunded"
    || stage === "funding_submitted"
    || stage === "funded";
  return value.chainId === 4221
    && value.network === "bradbury"
    && validStage
    && typeof value.id === "string"
    && value.id.length >= 16
    && isAddress(value.creator)
    && isFormSnapshot(value.draft)
    && Array.isArray(value.evidenceUrls)
    && value.evidenceUrls.every((url) => typeof url === "string")
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && typeof value.amountWei === "string"
    && DECIMAL_PATTERN.test(value.amountWei)
    && typeof value.fundingDeadlineSeconds === "string"
    && DECIMAL_PATTERN.test(value.fundingDeadlineSeconds)
    && typeof value.resolutionDeadlineSeconds === "string"
    && DECIMAL_PATTERN.test(value.resolutionDeadlineSeconds)
    && (value.contractAddress === undefined || isAddress(value.contractAddress))
    && (value.deploymentTxId === undefined || isTransactionHash(value.deploymentTxId))
    && (value.fundingTxId === undefined || isTransactionHash(value.fundingTxId))
    && (value.lastAction === undefined || isAction(value.lastAction))
    && (value.lastFailedTransaction === undefined || isFailedTransaction(value.lastFailedTransaction))
    && (value.pendingAction === undefined || isAction(value.pendingAction));
}

function isAction(value: unknown): value is NonNullable<PromiseBondLocalRecord["pendingAction"]> {
  if (!isStringRecord(value)) return false;
  const method = value.functionName;
  return (method === "resolve"
    || method === "expire_unfunded"
    || method === "refund_unresolved"
    || method === "refund_stale")
    && isTransactionHash(value.transactionId);
}

function isFailedTransaction(value: unknown): value is NonNullable<PromiseBondLocalRecord["lastFailedTransaction"]> {
  if (!isStringRecord(value)) return false;
  return (value.kind === "deployment" || value.kind === "funding" || value.kind === "action")
    && typeof value.failedAt === "string"
    && isTransactionHash(value.transactionId);
}

function browserStorage() {
  if (typeof window === "undefined") return undefined;
  return window.localStorage;
}

export function assertPromiseBondPersistenceAvailable() {
  const storage = browserStorage();
  if (!storage) throw new Error("This browser cannot persist pending PromiseBond transactions");
  const probe = `${PROMISEBOND_LOCAL_LEDGER_KEY}:probe`;
  try {
    storage.setItem(probe, "1");
    storage.removeItem(probe);
  } catch {
    throw new Error("Enable local browser storage before signing so pending transactions can be recovered");
  }
}

export function loadPromiseBondLocalRecords() {
  const storage = browserStorage();
  if (!storage) return [] as PromiseBondLocalRecord[];
  try {
    const raw = storage.getItem(PROMISEBOND_LOCAL_LEDGER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLocalRecord).slice(0, MAX_LOCAL_RECORDS);
  } catch {
    return [];
  }
}

export function savePromiseBondLocalRecords(records: PromiseBondLocalRecord[]) {
  assertPromiseBondPersistenceAvailable();
  const ordered = [...records]
    .filter(isLocalRecord)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_LOCAL_RECORDS);
  browserStorage()!.setItem(PROMISEBOND_LOCAL_LEDGER_KEY, JSON.stringify(ordered));
  return ordered;
}

export function createPromiseBondOperationId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
