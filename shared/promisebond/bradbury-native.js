import { createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import {
  ExecutionResult,
  TransactionHashVariant,
  TransactionStatus
} from "genlayer-js/types";
import { bytesToHex, getAddress, isAddress, keccak256, stringToHex } from "viem";

export const GENLAYER_BRADBURY_IDENTITY = Object.freeze({
  chainId: 4_221n,
  chainName: "Genlayer Bradbury Testnet",
  officialRpcUrl: "https://rpc-bradbury.genlayer.com",
  nativeCurrencyName: "GEN Token",
  nativeCurrencySymbol: "GEN",
  nativeCurrencyDecimals: 18,
  consensusMainAddress: "0x0112bf6e83497965a5fdd6dad1e447a6e004271d",
  consensusDataAddress: "0x85d7bf947a512fc640c75327a780c90847267697"
});

export const PROMISEBOND_NATIVE_POLICY_VERSION = "promisebond.native-gen.v1";
export const PROMISEBOND_NATIVE_SOURCE_KECCAK256 =
  "0xea739a4cc74438ffebb4656fd2ebc39d2a1df2239a6a9722ac227009c0488ea1";
export const PROMISEBOND_BRADBURY_BROADCAST_AUTHORIZATION =
  "PROMISEBOND_BRADBURY_BROADCAST_V1";

export const PROMISEBOND_WRITE_METHODS = Object.freeze([
  "fund",
  "resolve",
  "expire_unfunded",
  "refund_unresolved",
  "refund_stale"
]);

const WRITE_METHOD_SET = new Set(PROMISEBOND_WRITE_METHODS);
const CONSENSUS_RESULTS = new Set(["AGREE", "MAJORITY_AGREE"]);
const CONSENSUS_RESULT_NUMBERS = Object.freeze({ AGREE: 1n, MAJORITY_AGREE: 6n });
const SETTLEMENTS = new Set([
  "UNFUNDED",
  "LOCKED",
  "PAYOUT_QUEUED",
  "EXPIRED"
]);
const OUTCOMES = new Set(["NONE", "FULFILLED", "FAILED", "UNRESOLVED"]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const UNRESOLVED_PAYOUT_DELAY = 7n * 24n * 60n * 60n;
const STALE_PAYOUT_DELAY = 30n * 24n * 60n * 60n;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

function fail(message) {
  throw new Error(`PromiseBond Bradbury client rejected: ${message}`);
}

function normalizeAddressLike(value, label, { allowZero = false } = {}) {
  let candidate = value;
  if (
    candidate &&
    typeof candidate === "object" &&
    candidate.bytes instanceof Uint8Array &&
    candidate.bytes.length === 20
  ) {
    candidate = bytesToHex(candidate.bytes);
  }
  if (typeof candidate !== "string" || !isAddress(candidate, { strict: false })) {
    fail(`${label} must be a 20-byte EVM address`);
  }
  const normalized = getAddress(candidate.toLowerCase()).toLowerCase();
  if (!allowZero && normalized === ZERO_ADDRESS) fail(`${label} must not be zero`);
  return normalized;
}

function normalizeHash(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    fail(`${label} must be a 32-byte transaction hash`);
  }
  return value.toLowerCase();
}

function normalizeReadUnsigned(value, label, maximum = UINT256_MAX) {
  let parsed;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number" && Number.isSafeInteger(value)) {
    parsed = BigInt(value);
  } else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    parsed = BigInt(value);
  } else {
    fail(`${label} must be an exact unsigned integer`);
  }
  if (parsed < 0n || parsed > maximum) fail(`${label} is outside its integer range`);
  return parsed;
}

export function normalizeGenWei(value, { allowZero = false, label = "GEN value" } = {}) {
  if (typeof value === "number") {
    fail(`${label} must be supplied as bigint or a base-10 integer string, never Number`);
  }
  const parsed = normalizeReadUnsigned(value, label);
  if (!allowZero && parsed === 0n) fail(`${label} must be greater than zero`);
  return parsed;
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label} does not match (${String(actual)} != ${String(expected)})`);
}

function requireString(value, label) {
  if (typeof value !== "string") fail(`${label} must be a string`);
  return value;
}

function readField(value, field) {
  if (!value || typeof value !== "object" || !(field in value)) {
    fail(`finalized contract state is missing ${field}`);
  }
  return value[field];
}

function decodeContractValue(value) {
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, nested]) => [String(key), decodeContractValue(nested)])
    );
  }
  if (Array.isArray(value)) return value.map(decodeContractValue);
  if (value instanceof Uint8Array) return value;
  if (value && typeof value === "object") {
    if (value.bytes instanceof Uint8Array && value.bytes.length === 20) return value;
    if (Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [key, decodeContractValue(nested)])
      );
    }
  }
  return value;
}

function normalizeBradburyDefinition(chain) {
  if (!chain || typeof chain !== "object") fail("client chain definition is missing");
  requireEqual(BigInt(chain.id ?? -1), GENLAYER_BRADBURY_IDENTITY.chainId, "Bradbury chain ID");
  requireEqual(chain.name, GENLAYER_BRADBURY_IDENTITY.chainName, "Bradbury chain name");
  requireEqual(
    chain.nativeCurrency?.name,
    GENLAYER_BRADBURY_IDENTITY.nativeCurrencyName,
    "Bradbury native currency name"
  );
  requireEqual(
    chain.nativeCurrency?.symbol,
    GENLAYER_BRADBURY_IDENTITY.nativeCurrencySymbol,
    "Bradbury native currency symbol"
  );
  requireEqual(
    Number(chain.nativeCurrency?.decimals),
    GENLAYER_BRADBURY_IDENTITY.nativeCurrencyDecimals,
    "Bradbury native currency decimals"
  );
  requireEqual(
    normalizeAddressLike(chain.consensusMainContract?.address, "Bradbury consensus main address"),
    GENLAYER_BRADBURY_IDENTITY.consensusMainAddress,
    "Bradbury consensus main address"
  );
  requireEqual(
    normalizeAddressLike(chain.consensusDataContract?.address, "Bradbury consensus data address"),
    GENLAYER_BRADBURY_IDENTITY.consensusDataAddress,
    "Bradbury consensus data address"
  );
  return chain;
}

function cloneBradburyChain() {
  normalizeBradburyDefinition(testnetBradbury);
  return {
    ...testnetBradbury,
    nativeCurrency: { ...testnetBradbury.nativeCurrency },
    rpcUrls: {
      ...testnetBradbury.rpcUrls,
      default: {
        ...testnetBradbury.rpcUrls.default,
        http: [...testnetBradbury.rpcUrls.default.http]
      }
    },
    consensusMainContract: testnetBradbury.consensusMainContract
      ? { ...testnetBradbury.consensusMainContract }
      : null,
    consensusDataContract: testnetBradbury.consensusDataContract
      ? { ...testnetBradbury.consensusDataContract }
      : null
  };
}

function bindReadClient(client, chain) {
  return Object.freeze({
    chain,
    getChainId: client.getChainId.bind(client),
    getContractCode: client.getContractCode.bind(client),
    getTransaction: client.getTransaction.bind(client),
    readContract: client.readContract.bind(client),
    waitForTransactionReceipt: client.waitForTransactionReceipt.bind(client)
  });
}

/**
 * Creates a deliberately read-only Bradbury facade. It has no account/provider and does not
 * expose writeContract, connect, deployContract, or any private-key helper.
 */
export function createPromiseBondBradburyReadClient({
  rpcUrl = GENLAYER_BRADBURY_IDENTITY.officialRpcUrl
} = {}) {
  if (typeof rpcUrl !== "string" || !rpcUrl.trim()) fail("Bradbury RPC URL is required");
  let endpoint;
  try {
    endpoint = new URL(rpcUrl.trim());
  } catch {
    fail("Bradbury RPC URL must be an absolute URL");
  }
  if (endpoint.protocol !== "https:") fail("Bradbury RPC URL must use HTTPS");
  if (endpoint.username || endpoint.password || endpoint.hash) {
    fail("Bradbury RPC URL must not contain credentials or a fragment");
  }

  // genlayer-js 1.1.8 mutates rpcUrls when endpoint is supplied. Never pass its exported
  // singleton directly or one PromiseBond client can silently reconfigure another.
  const isolatedChain = cloneBradburyChain();
  const client = createClient({ chain: isolatedChain, endpoint: endpoint.href });
  return bindReadClient(client, isolatedChain);
}

export async function assertPromiseBondBradburyClient(client) {
  normalizeBradburyDefinition(client?.chain);
  if (typeof client.getChainId !== "function") fail("client cannot verify its live chain ID");
  const liveChainId = await client.getChainId();
  requireEqual(BigInt(liveChainId), GENLAYER_BRADBURY_IDENTITY.chainId, "live Bradbury chain ID");
}

/** Fail closed unless the deployed source is byte-for-byte the reviewed native release. */
export async function assertPromiseBondContractIdentity({ client, contractAddress }) {
  const address = normalizeAddressLike(contractAddress, "PromiseBond contract address");
  if (!client || typeof client.getContractCode !== "function") {
    fail("client cannot verify deployed PromiseBond source code");
  }
  const source = await client.getContractCode(address);
  if (typeof source !== "string" || source.length === 0) {
    fail("deployed PromiseBond source code is missing");
  }
  const sourceKeccak256 = keccak256(stringToHex(source)).toLowerCase();
  requireEqual(
    sourceKeccak256,
    PROMISEBOND_NATIVE_SOURCE_KECCAK256,
    "deployed PromiseBond source hash"
  );
  return Object.freeze({ address, sourceKeccak256 });
}

function canonicalizeFinalizedSnapshot(termsValue, stateValue, balanceValue) {
  const rawTerms = decodeContractValue(termsValue);
  const rawState = decodeContractValue(stateValue);
  const contractBalanceWei = normalizeReadUnsigned(balanceValue, "contract GEN balance");

  const terms = Object.freeze({
    policyVersion: requireString(readField(rawTerms, "policy_version"), "policy version"),
    creator: normalizeAddressLike(readField(rawTerms, "creator"), "creator"),
    beneficiary: normalizeAddressLike(readField(rawTerms, "beneficiary"), "beneficiary"),
    bondAmountWei: normalizeReadUnsigned(readField(rawTerms, "bond_amount_wei"), "bond amount"),
    fundingDeadline: normalizeReadUnsigned(
      readField(rawTerms, "funding_deadline"),
      "funding deadline",
      UINT64_MAX
    ),
    deadline: normalizeReadUnsigned(readField(rawTerms, "deadline"), "deadline", UINT64_MAX),
    promiseText: requireString(readField(rawTerms, "promise_text"), "promise text"),
    successCriteria: requireString(readField(rawTerms, "success_criteria"), "success criteria"),
    failureCriteria: requireString(readField(rawTerms, "failure_criteria"), "failure criteria"),
    evidenceUrlsJson: requireString(readField(rawTerms, "evidence_urls"), "evidence URLs")
  });

  const settlement = requireString(readField(rawState, "settlement"), "settlement");
  const outcome = requireString(readField(rawState, "outcome"), "outcome");
  if (!SETTLEMENTS.has(settlement)) fail(`unknown settlement ${settlement}`);
  if (!OUTCOMES.has(outcome)) fail(`unknown outcome ${outcome}`);

  const state = Object.freeze({
    settlement,
    outcome,
    bondAmountWei: normalizeReadUnsigned(readField(rawState, "bond_amount_wei"), "state bond amount"),
    lockedAmountWei: normalizeReadUnsigned(readField(rawState, "locked_amount_wei"), "locked amount"),
    fundedAt: normalizeReadUnsigned(readField(rawState, "funded_at"), "funded_at", UINT64_MAX),
    resolvedAt: normalizeReadUnsigned(readField(rawState, "resolved_at"), "resolved_at", UINT64_MAX),
    settlementQueuedAt: normalizeReadUnsigned(
      readField(rawState, "settlement_queued_at"),
      "settlement_queued_at",
      UINT64_MAX
    ),
    payoutRecipient: normalizeAddressLike(readField(rawState, "payout_recipient"), "payout recipient", {
      allowZero: true
    }),
    reasoning: requireString(readField(rawState, "reasoning"), "reasoning"),
    decisiveEvidence: requireString(readField(rawState, "decisive_evidence"), "decisive evidence")
  });

  requireEqual(terms.policyVersion, PROMISEBOND_NATIVE_POLICY_VERSION, "PromiseBond policy version");
  if (terms.creator === terms.beneficiary) fail("creator and beneficiary must differ");
  if (terms.bondAmountWei === 0n) fail("bond amount must be greater than zero");
  if (terms.fundingDeadline === 0n || terms.deadline <= terms.fundingDeadline) {
    fail("funding and resolution deadlines are inconsistent");
  }
  requireEqual(state.bondAmountWei, terms.bondAmountWei, "terms/state bond amount");
  if (state.lockedAmountWei > state.bondAmountWei) fail("locked amount exceeds bond amount");
  if (contractBalanceWei < state.lockedAmountWei) fail("contract balance is below its locked liability");

  if (state.outcome === "NONE" && (state.reasoning || state.decisiveEvidence)) {
    fail("unresolved outcome cannot contain resolution evidence");
  }
  if (state.outcome !== "NONE" && (!state.reasoning || !state.decisiveEvidence)) {
    fail("resolved outcome must contain reasoning and decisive evidence");
  }

  switch (state.settlement) {
    case "UNFUNDED":
      if (
        state.outcome !== "NONE" || state.lockedAmountWei !== 0n || state.fundedAt !== 0n ||
        state.resolvedAt !== 0n || state.settlementQueuedAt !== 0n ||
        state.payoutRecipient !== ZERO_ADDRESS
      ) fail("UNFUNDED state violates PromiseBond invariants");
      break;
    case "EXPIRED":
      if (
        state.outcome !== "NONE" || state.lockedAmountWei !== 0n || state.fundedAt !== 0n ||
        state.resolvedAt !== 0n || state.settlementQueuedAt !== 0n ||
        state.payoutRecipient !== ZERO_ADDRESS
      ) fail("EXPIRED state violates PromiseBond invariants");
      break;
    case "LOCKED":
      if (
        state.lockedAmountWei !== state.bondAmountWei || state.fundedAt === 0n ||
        state.settlementQueuedAt !== 0n || state.payoutRecipient !== ZERO_ADDRESS
      ) fail("LOCKED state violates PromiseBond invariants");
      if (state.outcome === "NONE" && state.resolvedAt !== 0n) {
        fail("unresolved LOCKED state cannot have resolved_at");
      }
      if (state.outcome === "UNRESOLVED" && state.resolvedAt === 0n) {
        fail("UNRESOLVED state must have resolved_at");
      }
      if (state.outcome === "FULFILLED" || state.outcome === "FAILED") {
        fail("winner outcome must queue its payout in the same finalized state transition");
      }
      break;
    case "PAYOUT_QUEUED": {
      if (
        state.lockedAmountWei !== 0n || state.fundedAt === 0n || state.resolvedAt === 0n ||
        state.settlementQueuedAt === 0n
      ) fail("PAYOUT_QUEUED state violates PromiseBond invariants");
      const expectedRecipient = state.outcome === "FULFILLED"
        ? terms.creator
        : state.outcome === "FAILED" || state.outcome === "UNRESOLVED"
          ? terms.beneficiary
          : null;
      const unresolvedDelaySatisfied = state.outcome !== "UNRESOLVED"
        || state.settlementQueuedAt >= state.resolvedAt + UNRESOLVED_PAYOUT_DELAY;
      if (
        !expectedRecipient || state.payoutRecipient !== expectedRecipient ||
        state.resolvedAt < terms.deadline || state.settlementQueuedAt < state.resolvedAt ||
        !unresolvedDelaySatisfied
      ) {
        fail("PAYOUT_QUEUED state violates PromiseBond invariants");
      }
      break;
    }
  }

  return Object.freeze({
    terms,
    state,
    contractBalanceWei,
    readVariant: TransactionHashVariant.LATEST_FINAL
  });
}

/** Reads every authoritative PromiseBond view from finalized state only. */
export async function readFinalizedPromiseBond({ client, contractAddress }) {
  await assertPromiseBondBradburyClient(client);
  const address = normalizeAddressLike(contractAddress, "PromiseBond contract address");
  await assertPromiseBondContractIdentity({ client, contractAddress: address });
  const common = Object.freeze({
    address,
    args: [],
    jsonSafeReturn: false,
    transactionHashVariant: TransactionHashVariant.LATEST_FINAL
  });
  const [terms, state, balance] = await Promise.all([
    client.readContract({ ...common, functionName: "get_terms" }),
    client.readContract({ ...common, functionName: "get_state" }),
    client.readContract({ ...common, functionName: "get_contract_balance" })
  ]);
  return canonicalizeFinalizedSnapshot(terms, state, balance);
}

function isEmptyCallValue(value) {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Map) return value.size === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function transactionField(callData, name) {
  return callData instanceof Map ? callData.get(name) : callData?.[name];
}

function assertNumericReceiptField(value, expected, label) {
  if (value === undefined) return;
  const parsed = normalizeReadUnsigned(value, label, 255n);
  requireEqual(parsed, expected, label);
}

export function assertFinalizedSuccessfulPromiseBondTransaction({
  contractAddress,
  expectedMethod,
  expectedNativeValueWei = 0n,
  expectedSender,
  receipt,
  transactionHash
}) {
  const hash = normalizeHash(transactionHash, "transaction hash");
  const address = normalizeAddressLike(contractAddress, "PromiseBond contract address");
  if (!WRITE_METHOD_SET.has(expectedMethod)) fail(`unsupported PromiseBond method ${expectedMethod}`);
  const expectedValue = normalizeGenWei(expectedNativeValueWei, {
    allowZero: true,
    label: "expected native GEN value"
  });
  if (!receipt || typeof receipt !== "object") fail("full transaction receipt is missing");

  requireEqual(receipt.statusName, TransactionStatus.FINALIZED, "transaction status");
  assertNumericReceiptField(receipt.status, 7n, "numeric transaction status");
  requireEqual(
    receipt.txExecutionResultName,
    ExecutionResult.FINISHED_WITH_RETURN,
    "transaction execution result"
  );
  assertNumericReceiptField(receipt.txExecutionResult, 1n, "numeric execution result");
  if (!CONSENSUS_RESULTS.has(String(receipt.resultName ?? ""))) {
    fail("transaction consensus result must be AGREE or MAJORITY_AGREE");
  }
  assertNumericReceiptField(
    receipt.result,
    CONSENSUS_RESULT_NUMBERS[receipt.resultName],
    "numeric consensus result"
  );
  requireEqual(normalizeHash(receipt.txId, "receipt transaction ID"), hash, "transaction ID");
  if (receipt.hash !== undefined) {
    requireEqual(normalizeHash(receipt.hash, "receipt hash"), hash, "receipt hash");
  }
  requireEqual(
    normalizeAddressLike(receipt.recipient, "transaction recipient"),
    address,
    "transaction recipient"
  );
  if (receipt.to_address !== undefined) {
    requireEqual(
      normalizeAddressLike(receipt.to_address, "transaction to_address"),
      address,
      "transaction to_address"
    );
  }
  if (expectedSender !== undefined) {
    const observedSender = receipt.sender ?? receipt.from_address;
    requireEqual(
      normalizeAddressLike(observedSender, "transaction sender"),
      normalizeAddressLike(expectedSender, "expected transaction sender"),
      "transaction sender"
    );
  }

  const decoded = receipt.txDataDecoded;
  if (!decoded || decoded.type !== "call") fail("transaction must decode as a contract call");
  if (decoded.leaderOnly !== false) fail("transaction must use validator consensus, not leader-only mode");
  const method = transactionField(decoded.callData, "method");
  const args = transactionField(decoded.callData, "args");
  const kwargs = transactionField(decoded.callData, "kwargs");
  requireEqual(method, expectedMethod, "transaction method");
  if (!isEmptyCallValue(args) || !isEmptyCallValue(kwargs)) {
    fail("PromiseBond write methods must not receive arguments or keyword arguments");
  }

  // Bradbury's getTransactionData does not currently expose the outer native value. Validate
  // it when a provider supplies it; otherwise the exact request plus finalized fund invariant
  // is the authoritative end-to-end check performed by broadcastPromiseBondWrite below.
  let receiptValueObserved = false;
  if (receipt.value !== undefined) {
    receiptValueObserved = true;
    requireEqual(
      normalizeReadUnsigned(receipt.value, "receipt native GEN value"),
      expectedValue,
      "receipt native GEN value"
    );
  }
  return Object.freeze({ hash, receipt, receiptValueObserved });
}

export async function waitForFinalizedPromiseBondTransaction({
  client,
  contractAddress,
  expectedMethod,
  expectedNativeValueWei = 0n,
  expectedSender,
  intervalMs = 3_000,
  retries = 50,
  transactionHash
}) {
  await assertPromiseBondBradburyClient(client);
  const hash = normalizeHash(transactionHash, "transaction hash");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) fail("finality interval must be nonnegative");
  if (!Number.isSafeInteger(retries) || retries < 0) fail("finality retries must be nonnegative");

  // In genlayer-js 1.1.8 the polling result is simplified and can omit decoded Map fields.
  // Treat it only as a barrier, then fetch and validate the full transaction object.
  await client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.FINALIZED,
    interval: intervalMs,
    retries
  });
  const receipt = await client.getTransaction({ hash });
  return assertFinalizedSuccessfulPromiseBondTransaction({
    contractAddress,
    expectedMethod,
    expectedNativeValueWei,
    expectedSender,
    receipt,
    transactionHash: hash
  });
}

export function buildPromiseBondWriteRequest({
  contractAddress,
  method,
  valueWei = 0n
}) {
  const address = normalizeAddressLike(contractAddress, "PromiseBond contract address");
  if (!WRITE_METHOD_SET.has(method)) fail(`unsupported PromiseBond method ${String(method)}`);
  const value = normalizeGenWei(valueWei, { allowZero: method !== "fund" });
  if (method === "fund" && value === 0n) fail("fund must attach the configured GEN principal");
  if (method !== "fund" && value !== 0n) fail(`${method} must not attach GEN`);
  return Object.freeze({
    address,
    functionName: method,
    args: Object.freeze([]),
    value,
    leaderOnly: false
  });
}

function assertWritePostcondition(method, value, snapshot) {
  if (method === "fund") {
    requireEqual(snapshot.terms.bondAmountWei, value, "fund request/configured bond amount");
    requireEqual(snapshot.state.settlement, "LOCKED", "fund finalized settlement");
    requireEqual(snapshot.state.lockedAmountWei, value, "fund finalized locked amount");
  } else if (method === "resolve") {
    if (snapshot.state.outcome === "NONE") fail("resolve finalized without an outcome");
    if (
      snapshot.state.outcome === "UNRESOLVED" && snapshot.state.settlement !== "LOCKED"
    ) fail("UNRESOLVED resolve must retain the locked principal");
    if (
      ["FULFILLED", "FAILED"].includes(snapshot.state.outcome) &&
      snapshot.state.settlement !== "PAYOUT_QUEUED"
    ) fail("winner resolve must queue the finalized payout");
  } else if (method === "expire_unfunded") {
    requireEqual(snapshot.state.settlement, "EXPIRED", "expire finalized settlement");
  } else if (method === "refund_unresolved") {
    requireEqual(snapshot.state.settlement, "PAYOUT_QUEUED", "unresolved payout settlement");
    requireEqual(snapshot.state.outcome, "UNRESOLVED", "unresolved payout outcome");
    requireEqual(
      snapshot.state.payoutRecipient,
      snapshot.terms.beneficiary,
      "unresolved payout recipient"
    );
  } else {
    requireEqual(snapshot.state.settlement, "PAYOUT_QUEUED", "stale payout settlement");
    requireEqual(snapshot.state.outcome, "FAILED", "stale payout outcome");
    requireEqual(snapshot.state.payoutRecipient, snapshot.terms.beneficiary, "stale payout recipient");
    if (snapshot.state.resolvedAt < snapshot.terms.deadline + STALE_PAYOUT_DELAY) {
      fail("stale payout finalized before the fail-closed delay");
    }
  }
}

/**
 * The only broadcasting helper in this module. It never discovers a wallet or reads a key.
 * A caller must inject an already-configured wallet client and an explicit authorization token.
 */
export async function broadcastPromiseBondWrite({
  authorization,
  contractAddress,
  expectedSender,
  intervalMs = 3_000,
  method,
  readClient,
  retries = 50,
  valueWei = 0n,
  walletClient
}) {
  if (authorization !== PROMISEBOND_BRADBURY_BROADCAST_AUTHORIZATION) {
    fail("broadcast is disabled without explicit PROMISEBOND_BRADBURY_BROADCAST_V1 authorization");
  }
  if (!walletClient || typeof walletClient.writeContract !== "function") {
    fail("an explicitly configured wallet client is required for broadcast");
  }
  const reader = readClient ?? walletClient;
  const request = buildPromiseBondWriteRequest({ contractAddress, method, valueWei });
  await assertPromiseBondBradburyClient(walletClient);
  if (reader !== walletClient) await assertPromiseBondBradburyClient(reader);
  await assertPromiseBondContractIdentity({ client: reader, contractAddress: request.address });

  const transactionHash = await walletClient.writeContract(request);
  const finalized = await waitForFinalizedPromiseBondTransaction({
    client: reader,
    contractAddress: request.address,
    expectedMethod: method,
    expectedNativeValueWei: request.value,
    expectedSender,
    intervalMs,
    retries,
    transactionHash
  });
  const snapshot = await readFinalizedPromiseBond({
    client: reader,
    contractAddress: request.address
  });
  assertWritePostcondition(method, request.value, snapshot);

  return Object.freeze({
    transactionHash: finalized.hash,
    receipt: finalized.receipt,
    receiptValueObserved: finalized.receiptValueObserved,
    snapshot
  });
}
