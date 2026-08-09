import { GENLAYER_BRADBURY_IDENTITY, PROMISEBOND_NATIVE_SOURCE_KECCAK256 } from "../../shared/promisebond/bradbury-native.js";
import { TransactionHashVariant } from "genlayer-js/types";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const MAX_CURSOR_LENGTH = 384;

export class PromiseBondValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PromiseBondValidationError";
  }
}

export function normalizeContractAddress(value, label = "contractAddress") {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    throw new PromiseBondValidationError(`${label} must be a 20-byte 0x-prefixed address`);
  }
  const normalized = value.toLowerCase();
  if (normalized === ZERO_ADDRESS) {
    throw new PromiseBondValidationError(`${label} must not be the zero address`);
  }
  return normalized;
}

function decimalString(value, label) {
  const candidate = typeof value === "bigint" ? value.toString(10) : value;
  if (typeof candidate !== "string" || !DECIMAL_PATTERN.test(candidate)) {
    throw new TypeError(`${label} must be an exact unsigned integer`);
  }
  return candidate;
}

function requiredString(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function requiredDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid date`);
  return date;
}

function finalizedStateRevision(state) {
  if (state.settlement === "UNFUNDED" && state.outcome === "NONE") return 0;
  if (state.settlement === "LOCKED" && state.outcome === "NONE") return 1;
  if (state.settlement === "LOCKED" && state.outcome === "UNRESOLVED") return 2;
  if (state.settlement === "PAYOUT_QUEUED" || state.settlement === "EXPIRED") return 3;
  throw new TypeError("snapshot state is not a recognized monotonic PromiseBond transition");
}

export function serializeFinalizedSnapshot({ contractAddress, snapshot, observedAt }) {
  const address = normalizeContractAddress(contractAddress);
  if (!snapshot || typeof snapshot !== "object") {
    throw new TypeError("finalized snapshot is required");
  }
  const terms = snapshot.terms;
  const state = snapshot.state;
  if (!terms || !state) throw new TypeError("finalized snapshot terms and state are required");
  if (snapshot.readVariant !== TransactionHashVariant.LATEST_FINAL) {
    throw new TypeError("snapshot must come from the exact latest-final read variant");
  }

  const serializedTerms = {
    policyVersion: requiredString(terms.policyVersion, "policyVersion"),
    creator: normalizeContractAddress(terms.creator, "creator"),
    beneficiary: normalizeContractAddress(terms.beneficiary, "beneficiary"),
    bondAmountWei: decimalString(terms.bondAmountWei, "bondAmountWei"),
    fundingDeadline: decimalString(terms.fundingDeadline, "fundingDeadline"),
    deadline: decimalString(terms.deadline, "deadline"),
    promiseText: requiredString(terms.promiseText, "promiseText"),
    successCriteria: requiredString(terms.successCriteria, "successCriteria"),
    failureCriteria: requiredString(terms.failureCriteria, "failureCriteria"),
    evidenceUrlsJson: requiredString(terms.evidenceUrlsJson, "evidenceUrlsJson")
  };
  const serializedState = {
    settlement: requiredString(state.settlement, "settlement"),
    outcome: requiredString(state.outcome, "outcome"),
    bondAmountWei: decimalString(state.bondAmountWei, "state bondAmountWei"),
    lockedAmountWei: decimalString(state.lockedAmountWei, "lockedAmountWei"),
    fundedAt: decimalString(state.fundedAt, "fundedAt"),
    resolvedAt: decimalString(state.resolvedAt, "resolvedAt"),
    settlementQueuedAt: decimalString(state.settlementQueuedAt, "settlementQueuedAt"),
    payoutRecipient: typeof state.payoutRecipient === "string" && ADDRESS_PATTERN.test(state.payoutRecipient)
      ? state.payoutRecipient.toLowerCase()
      : (() => { throw new TypeError("payoutRecipient must be a 20-byte address"); })(),
    reasoning: requiredString(state.reasoning, "reasoning"),
    decisiveEvidence: requiredString(state.decisiveEvidence, "decisiveEvidence")
  };

  return {
    network: "bradbury",
    chainId: GENLAYER_BRADBURY_IDENTITY.chainId.toString(10),
    contractAddress: address,
    sourceKeccak256: PROMISEBOND_NATIVE_SOURCE_KECCAK256,
    creatorAddress: serializedTerms.creator,
    beneficiaryAddress: serializedTerms.beneficiary,
    status: serializedState.settlement,
    outcome: serializedState.outcome,
    stateRevision: finalizedStateRevision(serializedState),
    bondAmountWei: serializedTerms.bondAmountWei,
    fundingDeadline: serializedTerms.fundingDeadline,
    deadline: serializedTerms.deadline,
    terms: serializedTerms,
    state: serializedState,
    contractBalanceWei: decimalString(snapshot.contractBalanceWei, "contractBalanceWei"),
    finalizedReadVariant: TransactionHashVariant.LATEST_FINAL,
    finalizedStateObservedAt: requiredDate(observedAt, "observedAt")
  };
}

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function toPublicBond(document) {
  if (!document) return null;
  return {
    network: document.network,
    chainId: document.chainId,
    contractAddress: document.contractAddress,
    sourceKeccak256: document.sourceKeccak256,
    creatorAddress: document.creatorAddress,
    beneficiaryAddress: document.beneficiaryAddress,
    status: document.status,
    outcome: document.outcome,
    bondAmountWei: document.bondAmountWei,
    fundingDeadline: document.fundingDeadline,
    deadline: document.deadline,
    terms: document.terms,
    state: document.state,
    contractBalanceWei: document.contractBalanceWei,
    finalizedReadVariant: document.finalizedReadVariant,
    createdAt: isoDate(document.createdAt),
    updatedAt: isoDate(document.updatedAt),
    finalizedStateObservedAt: isoDate(document.finalizedStateObservedAt)
  };
}

export function encodeBondCursor(document) {
  const payload = JSON.stringify({
    v: 1,
    t: requiredDate(document.createdAt, "createdAt").toISOString(),
    a: normalizeContractAddress(document.contractAddress)
  });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeBondCursor(value) {
  if (
    typeof value !== "string" || value.length === 0 || value.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new PromiseBondValidationError("cursor is invalid");
  }
  let decoded;
  try {
    const buffer = Buffer.from(value, "base64url");
    if (buffer.toString("base64url") !== value) throw new Error("non-canonical cursor");
    decoded = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new PromiseBondValidationError("cursor is invalid");
  }
  if (
    !decoded || typeof decoded !== "object" || Array.isArray(decoded) || decoded.v !== 1 ||
    Object.keys(decoded).sort().join(",") !== "a,t,v" || typeof decoded.t !== "string"
  ) {
    throw new PromiseBondValidationError("cursor is invalid");
  }
  const createdAt = new Date(decoded.t);
  if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== decoded.t) {
    throw new PromiseBondValidationError("cursor is invalid");
  }
  return { createdAt, contractAddress: normalizeContractAddress(decoded.a, "cursor address") };
}

export function parsePublicListQuery(query) {
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    throw new PromiseBondValidationError("query is invalid");
  }
  const keys = Object.keys(query);
  if (keys.some((key) => (
    key !== "limit" && key !== "cursor" && key !== "creator" &&
    key !== "__promisebond_path"
  ))) {
    throw new PromiseBondValidationError("only limit, cursor, and creator query parameters are supported");
  }
  if (
    query.__promisebond_path !== undefined &&
    query.__promisebond_path !== "contracts"
  ) {
    throw new PromiseBondValidationError("PromiseBond route metadata is invalid");
  }
  const rawLimit = query.limit;
  if (rawLimit !== undefined && (typeof rawLimit !== "string" || !/^[1-9][0-9]*$/.test(rawLimit))) {
    throw new PromiseBondValidationError("limit must be an integer from 1 to 100");
  }
  const limit = rawLimit === undefined ? 20 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new PromiseBondValidationError("limit must be an integer from 1 to 100");
  }
  if (query.cursor !== undefined && typeof query.cursor !== "string") {
    throw new PromiseBondValidationError("cursor must be supplied once");
  }
  if (query.creator !== undefined && typeof query.creator !== "string") {
    throw new PromiseBondValidationError("creator must be supplied once");
  }
  return {
    limit,
    cursor: query.cursor === undefined ? null : decodeBondCursor(query.cursor),
    creator: query.creator === undefined ? null : normalizeContractAddress(query.creator, "creator")
  };
}

export function parseRegistrationBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PromiseBondValidationError("JSON body must be an object");
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "contractAddress") {
    throw new PromiseBondValidationError("body must contain only contractAddress");
  }
  return { contractAddress: normalizeContractAddress(body.contractAddress) };
}
