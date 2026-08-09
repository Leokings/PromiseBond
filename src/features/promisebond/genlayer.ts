import { createClient } from "genlayer-js";
import {
  CalldataAddress,
  ExecutionResult,
  TransactionHashVariant,
  TransactionResult,
  TransactionStatus,
  type GenLayerTransaction,
  type TransactionHash
} from "genlayer-js/types";
import { bytesToHex, getAddress, parseUnits, type Address } from "viem";
import promiseBondSource from "../../../contracts/PromiseBond.py?raw";
import {
  promiseBondChain as promiseBondWalletChain,
  promiseBondGenLayerChain as promiseBondChain
} from "../../providers/PromiseBondWalletProvider";

const FINALITY_POLL_INTERVAL_MS = 3_000;
const BRADBURY_OBSERVED_APPEAL_WINDOW_MS = 30 * 60 * 1_000;
const FINALITY_SETTLEMENT_GRACE_MS = 30 * 60 * 1_000;
/**
 * Bradbury remains appealable for roughly 30 minutes after consensus. Every submitted-hash
 * reconciliation uses this FINALIZED barrier, with another full appeal window for pre-appeal
 * consensus and the network finalizer. A timeout remains non-terminal, so callers retain the
 * submitted hash and never rebroadcast merely because finality is delayed.
 */
export const PROMISEBOND_FINALITY_WAIT = Object.freeze({
  interval: FINALITY_POLL_INTERVAL_MS,
  retries: Math.ceil(
    (BRADBURY_OBSERVED_APPEAL_WINDOW_MS + FINALITY_SETTLEMENT_GRACE_MS)
      / FINALITY_POLL_INTERVAL_MS
  ),
  status: TransactionStatus.FINALIZED
});
const BRADBURY_CHAIN_ID_HEX = "0x107d";
const BRADBURY_WALLET_RPC_URL = promiseBondWalletChain.rpcUrls.default.http[0];
const BRADBURY_CONSENSUS_CONTRACTS = [
  "0x0112Bf6e83497965A5fdD6Dad1E447a6E004271D",
  "0x85D7bf947A512Fc640C75327A780c90847267697"
] as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const PROMISEBOND_POLICY_VERSION = "promisebond.native-gen.v1";
const UINT256_MAX = (1n << 256n) - 1n;
const UNRESOLVED_REFUND_DELAY = 7n * 24n * 60n * 60n;
const STALE_REFUND_DELAY = 30n * 24n * 60n * 60n;
const SETTLEMENTS = new Set(["UNFUNDED", "LOCKED", "PAYOUT_QUEUED", "REFUND_QUEUED", "EXPIRED"]);
const OUTCOMES = new Set(["NONE", "FULFILLED", "FAILED", "UNRESOLVED"]);
const EXECUTION_RESULT_NUMBERS: Readonly<Record<string, bigint>> = Object.freeze({
  [ExecutionResult.NOT_VOTED]: 0n,
  [ExecutionResult.FINISHED_WITH_RETURN]: 1n,
  [ExecutionResult.FINISHED_WITH_ERROR]: 2n
});
const CONSENSUS_RESULT_NUMBERS: Readonly<Record<string, bigint>> = Object.freeze({
  IDLE: 0n,
  AGREE: 1n,
  DISAGREE: 2n,
  TIMEOUT: 3n,
  DETERMINISTIC_VIOLATION: 4n,
  NO_MAJORITY: 5n,
  MAJORITY_AGREE: 6n,
  MAJORITY_DISAGREE: 7n
});
const DEFAULT_IGNORABLE_RANGES = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfff8],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff]
] as const;
const SAFE_CANONICAL_URL = /^https:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9._~!$&()*+,;=:@%/-]*)?(?:\?[A-Za-z0-9._~!$&()*+,;=:@%/?-]*)?$/;

type ClientConfig = NonNullable<Parameters<typeof createClient>[0]>;
export type PromiseBondWalletProvider = NonNullable<ClientConfig["provider"]>;

export type PromiseBondDraft = {
  amountWei: bigint;
  beneficiary: Address;
  deadline: bigint;
  evidenceUrls: string[];
  failureCriteria: string;
  fundingDeadline: bigint;
  promise: string;
  successCriteria: string;
};

export type PromiseBondDeployment = {
  contractAddress: Address;
  deploymentTxId: TransactionHash;
  fundingTxId: TransactionHash;
};

export type PromiseBondDeployedContract = Omit<PromiseBondDeployment, "fundingTxId">;

export type PromiseBondProgress =
  | "awaiting_deployment_signature"
  | "deployment_finalizing"
  | "deployment_finalized"
  | "awaiting_funding_signature"
  | "funding_finalizing"
  | "complete";

export type PromiseBondSubmittedCallback = (transactionId: TransactionHash) => void | Promise<void>;

/**
 * A trusted terminal classification: the requested PromiseBond transaction was observed on
 * Bradbury, matched the reviewed sender/calldata/source, and was FINALIZED unsuccessfully.
 */
export class PromiseBondFinalizedFailureError extends Error {
  readonly canClearSubmittedHash = true as const;
  readonly code = "PROMISEBOND_FINALIZED_FAILURE" as const;
  readonly consensusResult: TransactionResult;
  readonly executionResult: ExecutionResult;
  readonly status = TransactionStatus.FINALIZED as const;
  readonly terminal = true as const;
  readonly transactionId: TransactionHash;

  constructor({
    consensusResult,
    executionResult,
    label,
    transactionId
  }: {
    consensusResult: TransactionResult;
    executionResult: ExecutionResult;
    label: string;
    transactionId: TransactionHash;
  }) {
    super(`${label} was proven FINALIZED but unsuccessful (${executionResult} / ${consensusResult})`);
    this.name = "PromiseBondFinalizedFailureError";
    this.consensusResult = consensusResult;
    this.executionResult = executionResult;
    this.transactionId = transactionId;
  }
}

/**
 * The wallet proved no transaction hash was returned because its chain-4221 EVM RPC cannot
 * accept the JSON-RPC request envelope used by the wallet. It is safe to repair the RPC and retry.
 */
export class PromiseBondWalletRpcCompatibilityError extends Error {
  readonly code = "PROMISEBOND_WALLET_RPC_INCOMPATIBLE" as const;
  readonly noTransactionHashReturned = true as const;
  readonly repairRpcUrl = BRADBURY_WALLET_RPC_URL;

  constructor(message?: string, options?: ErrorOptions) {
    super(
      message
        || `Wallet EVM broadcast is not using ${BRADBURY_WALLET_RPC_URL} for GenLayer chain 4221.`,
      options
    );
    this.name = "PromiseBondWalletRpcCompatibilityError";
  }
}

export function isPromiseBondWalletRpcCompatibilityError(
  error: unknown
): error is PromiseBondWalletRpcCompatibilityError {
  return error instanceof PromiseBondWalletRpcCompatibilityError
    || Boolean(
      error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: unknown }).code === "PROMISEBOND_WALLET_RPC_INCOMPATIBLE"
      && "noTransactionHashReturned" in error
      && (error as { noTransactionHashReturned?: unknown }).noTransactionHashReturned === true
    );
}

/** Only this guard authorizes clearing a persisted submitted hash as a terminal failure. */
export function isPromiseBondFinalizedFailure(error: unknown): error is PromiseBondFinalizedFailureError {
  return error instanceof PromiseBondFinalizedFailureError;
}

export type PromiseBondTerms = {
  beneficiary: Address;
  bond_amount_wei: bigint;
  creator: Address;
  deadline: bigint;
  evidence_urls: string;
  failure_criteria: string;
  funding_deadline: bigint;
  policy_version: string;
  promise_text: string;
  success_criteria: string;
};

export type PromiseBondState = {
  bond_amount_wei: bigint;
  decisive_evidence: string;
  funded_at: bigint;
  locked_amount_wei: bigint;
  outcome: "NONE" | "FULFILLED" | "FAILED" | "UNRESOLVED";
  payout_recipient: Address;
  reasoning: string;
  resolved_at: bigint;
  /** QUEUED states prove transfer intent was emitted, not that the EVM recipient received GEN. */
  settlement: "UNFUNDED" | "LOCKED" | "PAYOUT_QUEUED" | "REFUND_QUEUED" | "EXPIRED";
  settlement_queued_at: bigint;
};

function bytesFromAddress(address: Address) {
  const hex = address.slice(2);
  const bytes = new Uint8Array(20);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function calldataAddress(address: Address) {
  return new CalldataAddress(bytesFromAddress(getAddress(address)));
}

function transactionHash(value: unknown, label: string): TransactionHash {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`GenLayer returned an invalid ${label} transaction ID`);
  }
  return value as TransactionHash;
}

function normalizeAddress(value: unknown, label: string, { allowZero = false } = {}): Address {
  let candidate = value;
  if (
    candidate
    && typeof candidate === "object"
    && "bytes" in candidate
    && candidate.bytes instanceof Uint8Array
    && candidate.bytes.length === 20
  ) {
    candidate = bytesToHex(candidate.bytes);
  }
  if (typeof candidate !== "string") throw new Error(`GenLayer omitted the ${label} address`);
  try {
    const address = getAddress(candidate);
    if (!allowZero && address.toLowerCase() === ZERO_ADDRESS) {
      throw new Error(`${label} address is zero`);
    }
    return address;
  } catch {
    throw new Error(`GenLayer returned an invalid ${label} address`);
  }
}

function transactionFailedDetail(receipt: GenLayerTransaction) {
  return [receipt.statusName, receipt.txExecutionResultName, receipt.resultName]
    .filter(Boolean)
    .join(" / ");
}

function receiptInteger(value: unknown, label: string) {
  let parsed: bigint;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === "string" && /^\d+$/.test(value)) parsed = BigInt(value);
  else throw new Error(`GenLayer returned an invalid numeric ${label}`);
  return parsed;
}

function requireExactReceiptInteger(value: unknown, expected: bigint, label: string) {
  const parsed = receiptInteger(value, label);
  if (parsed !== expected) throw new Error(`GenLayer returned a conflicting numeric ${label}`);
}

function isEmptyCallValue(value: unknown) {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Map) return value.size === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

function callDataField(value: unknown, field: string) {
  if (value instanceof Map) return value.get(field);
  if (value && typeof value === "object" && field in value) return (value as Record<string, unknown>)[field];
  return undefined;
}

function hasRuntimeCode(value: unknown) {
  return typeof value === "string"
    && /^0x(?:[0-9a-fA-F]{2})+$/.test(value)
    && /[1-9a-fA-F]/.test(value.slice(2));
}

const verifiedReadClients = new WeakSet<object>();

async function assertBradburyReadClient(client: ReturnType<typeof createClient>) {
  if (verifiedReadClients.has(client)) return;
  if (
    promiseBondChain.id !== 4_221
    || promiseBondChain.nativeCurrency.symbol !== "GEN"
    || promiseBondChain.nativeCurrency.decimals !== 18
  ) {
    throw new Error("PromiseBond is not pinned to native GEN on GenLayer Bradbury");
  }
  const configuredContracts = [
    promiseBondChain.consensusMainContract?.address,
    promiseBondChain.consensusDataContract?.address
  ];
  for (let index = 0; index < BRADBURY_CONSENSUS_CONTRACTS.length; index += 1) {
    if (
      normalizeAddress(configuredContracts[index], "configured Bradbury consensus contract")
      !== getAddress(BRADBURY_CONSENSUS_CONTRACTS[index])
    ) {
      throw new Error("PromiseBond SDK consensus contracts do not match the pinned Bradbury release");
    }
  }
  const [liveChainId, ...code] = await Promise.all([
    client.getChainId(),
    ...BRADBURY_CONSENSUS_CONTRACTS.map((address) => client.getBytecode({ address }))
  ]);
  if (liveChainId !== promiseBondChain.id) {
    throw new Error("PromiseBond read RPC is not GenLayer Bradbury (chain 4221)");
  }
  if (code.some((value) => !hasRuntimeCode(value))) {
    throw new Error("PromiseBond read RPC does not expose the pinned Bradbury consensus contracts");
  }
  verifiedReadClients.add(client);
}

type ExpectedTransaction =
  | { kind: "deploy"; sender: Address; source: string }
  | { address: Address; kind: "call"; method: string; sender: Address };

async function waitForFinalizedTransaction(
  client: ReturnType<typeof createClient>,
  hash: TransactionHash,
  label: string,
  expected: ExpectedTransaction
) {
  await assertBradburyReadClient(client);
  // genlayer-js 1.1.8 simplifies the wait result and drops decoded calldata.
  // Poll with it, then fetch the full canonical transaction for every check.
  await client.waitForTransactionReceipt({
    hash,
    ...PROMISEBOND_FINALITY_WAIT
  });
  const receipt = await client.getTransaction({ hash });
  if (!receipt.txId || receipt.txId.toLowerCase() !== hash.toLowerCase()) {
    throw new Error(`GenLayer returned a mismatched ${label} transaction ID`);
  }
  if (receipt.hash && receipt.hash.toLowerCase() !== hash.toLowerCase()) {
    throw new Error(`GenLayer returned a mismatched ${label} receipt hash`);
  }
  if (receipt.statusName !== TransactionStatus.FINALIZED) {
    throw new Error(`${label} has not been proven FINALIZED (${transactionFailedDetail(receipt) || "unknown state"})`);
  }
  requireExactReceiptInteger(receipt.status, 7n, "transaction status");

  const observedSender = receipt.sender || receipt.from_address;
  if (normalizeAddress(observedSender, "transaction sender") !== getAddress(expected.sender)) {
    throw new Error(`${label} sender does not match the connected wallet`);
  }
  const decoded = receipt.txDataDecoded;
  if (expected.kind === "deploy") {
    if (!decoded || decoded.type !== "deploy" || decoded.leaderOnly !== false) {
      throw new Error(`${label} was not a consensus deployment`);
    }
    if (!("code" in decoded) || decoded.code !== expected.source) {
      throw new Error(`${label} source does not match the reviewed PromiseBond release`);
    }
    // Failed deployments may retain the zero deployment recipient because no contract exists.
    const deployedAddress = normalizeAddress(receipt.recipient, "deployed contract", { allowZero: true });
    if (
      !("contractAddress" in decoded)
      || normalizeAddress(decoded.contractAddress, "decoded deployed contract", { allowZero: true }) !== deployedAddress
    ) {
      throw new Error(`${label} returned conflicting deployed contract addresses`);
    }
  } else {
    if (normalizeAddress(receipt.recipient, "transaction recipient") !== getAddress(expected.address)) {
      throw new Error(`${label} targeted a different contract`);
    }
    if (
      receipt.to_address !== undefined
      && normalizeAddress(receipt.to_address, "transaction to_address") !== getAddress(expected.address)
    ) {
      throw new Error(`${label} returned a conflicting transaction recipient`);
    }
    if (!decoded || decoded.type !== "call" || decoded.leaderOnly !== false) {
      throw new Error(`${label} was not a consensus contract call`);
    }
    const callData = "callData" in decoded ? decoded.callData : undefined;
    const method = callDataField(callData, "method");
    const args = callDataField(callData, "args");
    const kwargs = callDataField(callData, "kwargs");
    if (method !== expected.method || !isEmptyCallValue(args) || !isEmptyCallValue(kwargs)) {
      throw new Error(`${label} calldata does not match the reviewed action`);
    }
  }

  const executionResultName = receipt.txExecutionResultName;
  const executionResultNumber = typeof executionResultName === "string"
    ? EXECUTION_RESULT_NUMBERS[executionResultName]
    : undefined;
  if (executionResultNumber === undefined) {
    throw new Error(`${label} returned an unrecognized execution result; terminal failure is not proven`);
  }
  requireExactReceiptInteger(receipt.txExecutionResult, executionResultNumber, "execution result");
  const executionResult = executionResultName as ExecutionResult;

  const consensusResultName = receipt.resultName;
  const consensusResultNumber = typeof consensusResultName === "string"
    ? CONSENSUS_RESULT_NUMBERS[consensusResultName]
    : undefined;
  if (consensusResultNumber === undefined) {
    throw new Error(`${label} returned an unrecognized consensus result; terminal failure is not proven`);
  }
  requireExactReceiptInteger(receipt.result, consensusResultNumber, "consensus result");
  const consensusResult = consensusResultName as TransactionResult;

  const consensusAgreed = consensusResult === TransactionResult.AGREE
    || consensusResult === TransactionResult.MAJORITY_AGREE;
  if (executionResult !== ExecutionResult.FINISHED_WITH_RETURN || !consensusAgreed) {
    throw new PromiseBondFinalizedFailureError({
      consensusResult,
      executionResult,
      label,
      transactionId: hash
    });
  }
  return receipt;
}

function fullObject(value: unknown): Record<string, unknown> {
  if (value instanceof Map) return Object.fromEntries(value.entries()) as Record<string, unknown>;
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error("GenLayer returned an invalid PromiseBond state object");
}

function assertUnsignedBigInt(value: unknown, label: string, { allowZero = true } = {}) {
  if (typeof value !== "bigint") throw new Error(`GenLayer returned a lossy ${label}`);
  if (value < 0n || value > UINT256_MAX || (!allowZero && value === 0n)) {
    throw new Error(`GenLayer returned an out-of-range ${label}`);
  }
  return value;
}

function assertContractString(value: unknown, label: string) {
  if (typeof value !== "string") throw new Error(`GenLayer returned a non-string ${label}`);
  return value;
}

function asTerms(value: unknown): PromiseBondTerms {
  const result = fullObject(value);
  return {
    beneficiary: normalizeAddress(result.beneficiary, "beneficiary"),
    bond_amount_wei: assertUnsignedBigInt(result.bond_amount_wei, "bond amount", { allowZero: false }),
    creator: normalizeAddress(result.creator, "creator"),
    deadline: assertUnsignedBigInt(result.deadline, "deadline", { allowZero: false }),
    evidence_urls: assertContractString(result.evidence_urls, "evidence URLs"),
    failure_criteria: assertContractString(result.failure_criteria, "failure criteria"),
    funding_deadline: assertUnsignedBigInt(result.funding_deadline, "funding deadline", { allowZero: false }),
    policy_version: assertContractString(result.policy_version, "policy version"),
    promise_text: assertContractString(result.promise_text, "promise text"),
    success_criteria: assertContractString(result.success_criteria, "success criteria")
  };
}

function asState(value: unknown): PromiseBondState {
  const result = fullObject(value);
  return {
    bond_amount_wei: assertUnsignedBigInt(result.bond_amount_wei, "bond amount", { allowZero: false }),
    decisive_evidence: assertContractString(result.decisive_evidence, "decisive evidence"),
    funded_at: assertUnsignedBigInt(result.funded_at, "funded time"),
    locked_amount_wei: assertUnsignedBigInt(result.locked_amount_wei, "locked amount"),
    outcome: assertContractString(result.outcome, "outcome") as PromiseBondState["outcome"],
    payout_recipient: normalizeAddress(result.payout_recipient, "payout recipient", { allowZero: true }),
    reasoning: assertContractString(result.reasoning, "reasoning"),
    resolved_at: assertUnsignedBigInt(result.resolved_at, "resolved time"),
    settlement: assertContractString(result.settlement, "settlement") as PromiseBondState["settlement"],
    settlement_queued_at: assertUnsignedBigInt(result.settlement_queued_at, "settlement time")
  };
}

function assertFinalizedStateInvariants(
  terms: PromiseBondTerms,
  state: PromiseBondState,
  contractBalanceWei: bigint
) {
  if (terms.policy_version !== PROMISEBOND_POLICY_VERSION) {
    throw new Error("Finalized contract policy does not match this PromiseBond release");
  }
  if (terms.creator === terms.beneficiary || terms.deadline <= terms.funding_deadline) {
    throw new Error("PromiseBond finalized terms are inconsistent");
  }
  assertCanonicalText(terms.promise_text, "Finalized promise");
  assertCanonicalText(terms.success_criteria, "Finalized success criteria");
  assertCanonicalText(terms.failure_criteria, "Finalized failure criteria");
  let evidenceUrls: unknown;
  try {
    evidenceUrls = JSON.parse(terms.evidence_urls);
  } catch {
    throw new Error("PromiseBond finalized evidence URLs are not valid JSON");
  }
  if (!Array.isArray(evidenceUrls) || evidenceUrls.some((value) => typeof value !== "string")) {
    throw new Error("PromiseBond finalized evidence URLs are not a string array");
  }
  assertCanonicalEvidenceUrls(evidenceUrls);
  if (terms.evidence_urls !== JSON.stringify(evidenceUrls)) {
    throw new Error("PromiseBond finalized evidence URLs are not canonically encoded");
  }
  if (!SETTLEMENTS.has(state.settlement) || !OUTCOMES.has(state.outcome)) {
    throw new Error("GenLayer returned an unknown PromiseBond state");
  }
  if (state.bond_amount_wei !== terms.bond_amount_wei || state.locked_amount_wei > state.bond_amount_wei) {
    throw new Error("PromiseBond finalized accounting fields are inconsistent");
  }
  if (contractBalanceWei < state.locked_amount_wei) {
    throw new Error("PromiseBond finalized balance is below its locked liability");
  }
  if (state.outcome === "NONE" && (state.reasoning || state.decisive_evidence)) {
    throw new Error("PromiseBond unresolved state cannot contain resolution evidence");
  }
  if (state.outcome !== "NONE" && (!state.reasoning || !state.decisive_evidence)) {
    throw new Error("PromiseBond resolved state must contain reasoning and decisive evidence");
  }

  if (state.settlement === "UNFUNDED" || state.settlement === "EXPIRED") {
    if (
      state.outcome !== "NONE"
      || state.locked_amount_wei !== 0n
      || state.funded_at !== 0n
      || state.resolved_at !== 0n
      || state.settlement_queued_at !== 0n
      || state.payout_recipient !== ZERO_ADDRESS
    ) {
      throw new Error(`${state.settlement} state violates PromiseBond invariants`);
    }
    return;
  }

  if (state.settlement === "LOCKED") {
    if (
      state.locked_amount_wei !== state.bond_amount_wei
      || state.funded_at === 0n
      || state.settlement_queued_at !== 0n
      || state.payout_recipient !== ZERO_ADDRESS
      || state.outcome === "FULFILLED"
      || state.outcome === "FAILED"
    ) {
      throw new Error("LOCKED state violates PromiseBond invariants");
    }
    if (
      (state.outcome === "NONE" && state.resolved_at !== 0n)
      || (state.outcome === "UNRESOLVED" && (state.resolved_at < terms.deadline || state.resolved_at === 0n))
    ) {
      throw new Error("LOCKED resolution timestamps violate PromiseBond invariants");
    }
    return;
  }

  if (state.settlement === "PAYOUT_QUEUED") {
    const expectedRecipient = state.outcome === "FULFILLED"
      ? terms.creator
      : state.outcome === "FAILED" || state.outcome === "UNRESOLVED"
        ? terms.beneficiary
        : undefined;
    const unresolvedDelaySatisfied = state.outcome !== "UNRESOLVED"
      || state.settlement_queued_at >= state.resolved_at + UNRESOLVED_REFUND_DELAY;
    if (
      !expectedRecipient
      || state.locked_amount_wei !== 0n
      || state.funded_at === 0n
      || state.resolved_at < terms.deadline
      || state.settlement_queued_at < state.resolved_at
      || !unresolvedDelaySatisfied
      || state.payout_recipient !== expectedRecipient
    ) {
      throw new Error("PAYOUT_QUEUED state violates PromiseBond invariants");
    }
    return;
  }
  throw new Error("REFUND_QUEUED is not reachable under this fail-closed PromiseBond release");
}

function rpcErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function rpcErrorText(error: unknown) {
  const messages: string[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length > 0 && seen.size < 8) {
    const current = pending.shift();
    if (typeof current === "string") {
      messages.push(current);
      continue;
    }
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const field of ["message", "shortMessage", "details"] as const) {
      const value = (current as Record<string, unknown>)[field];
      if (typeof value === "string") messages.push(value);
    }
    for (const field of ["cause", "data", "error"] as const) {
      pending.push((current as Record<string, unknown>)[field]);
    }
  }
  return messages.join("\n");
}

function isBradburyStringIdTransportFailure(error: unknown) {
  const text = rpcErrorText(error);
  return /cannot unmarshal string into Go struct field Request\.id of type int/i.test(text);
}

export function withBradburyWalletRpcGuard(
  provider: PromiseBondWalletProvider
): PromiseBondWalletProvider {
  return {
    request: async (args: Parameters<PromiseBondWalletProvider["request"]>[0]) => {
      try {
        return await provider.request(args);
      } catch (error) {
        if (args.method === "eth_sendTransaction" && isBradburyStringIdTransportFailure(error)) {
          throw new PromiseBondWalletRpcCompatibilityError(
            `Wallet EVM broadcast used the incompatible Bradbury GenLayer RPC. `
            + `Select ${BRADBURY_WALLET_RPC_URL} as chain 4221's RPC in your wallet, then retry. `
            + "No PromiseBond transaction hash was returned.",
            { cause: error }
          );
        }
        throw error;
      }
    }
  } as PromiseBondWalletProvider;
}

function clientFor(account: Address, provider: PromiseBondWalletProvider) {
  return createClient({ account, chain: promiseBondChain, provider: withBradburyWalletRpcGuard(provider) });
}

function assertCanonicalText(value: string, label: string) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.replace(/\r\n?/g, "\n").normalize("NFC").replace(/^[ \n]+|[ \n]+$/g, "");
  if (value !== normalized) throw new Error(`${label} must already use normalized text without outer whitespace`);
  for (const character of normalized) {
    const codePoint = character.codePointAt(0) ?? 0;
    const explicitlyIgnorable = DEFAULT_IGNORABLE_RANGES.some(
      ([start, end]) => codePoint >= start && codePoint <= end
    );
    if (
      (codePoint <= 31 && codePoint !== 10)
      || (codePoint >= 127 && codePoint <= 159)
      || /\p{Cf}/u.test(character)
      || explicitlyIgnorable
    ) {
      throw new Error(`${label} contains a forbidden control character`);
    }
  }
  const byteLength = new TextEncoder().encode(normalized).length;
  if (byteLength < 20 || byteLength > 3_000) throw new Error(`${label} must contain 20 to 3000 UTF-8 bytes`);
}

function isPublicIpv4(parts: number[]) {
  const [a, b, c, d] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function assertCanonicalEvidenceUrls(urls: string[]) {
  if (!Array.isArray(urls) || urls.length < 2 || urls.length > 5) {
    throw new Error("Provide two to five independent evidence URLs");
  }
  const seen = new Set<string>();
  const authorities = new Set<string>();
  for (const raw of urls) {
    if (typeof raw !== "string") throw new Error("Evidence URLs must be strings");
    if (!/^[\x20-\x7e]+$/.test(raw)) throw new Error("Evidence URLs must use ASCII URL syntax");
    if (raw.includes("\\")) throw new Error("Evidence URLs must not contain backslashes");
    if (raw.endsWith("?")) throw new Error("Evidence URLs must not contain an empty query");
    if (/\/(?:\.|%2e)(?:\.|%2e)?(?:\/|[?#]|$)/i.test(raw)) {
      throw new Error("Evidence URLs must not contain dot path segments");
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("Every evidence source must be a valid HTTPS URL");
    }
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.hash
      || (url.port && url.port !== "443")
      || !url.hostname
    ) {
      throw new Error("Evidence URLs must be canonical public HTTPS URLs without credentials or fragments");
    }
    const hostname = url.hostname.toLowerCase();
    if (hostname.includes(":")) throw new Error("Evidence URLs must use DNS hostnames or canonical IPv4 addresses");
    const canonicalIpv4 = /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(hostname);
    const legacyIpv4 = /^(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+)){0,3}$/i.test(hostname);
    if (legacyIpv4 && !canonicalIpv4) {
      throw new Error("Evidence URLs must use canonical four-octet IPv4 syntax");
    }
    let ipv4Parts: number[] | undefined;
    if (canonicalIpv4) {
      ipv4Parts = hostname.split(".").map(Number);
      if (ipv4Parts.some((part) => part > 255)) throw new Error("Evidence URLs contain an invalid IPv4 address");
    }
    if (
      hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname.endsWith(".local")
      || hostname.endsWith(".internal")
      || hostname === "metadata.google.internal"
      || (ipv4Parts && !isPublicIpv4(ipv4Parts))
    ) {
      throw new Error("Evidence URLs must not target local or non-public addresses");
    }
    const canonical = `https://${hostname}${url.pathname || "/"}${url.search}`
      .replace(/%[0-9a-fA-F]{2}/g, (escape) => escape.toUpperCase());
    if (canonical !== raw || !SAFE_CANONICAL_URL.test(canonical)) {
      throw new Error("Evidence URLs must already use the canonical PromiseBond URL grammar");
    }
    if (new TextEncoder().encode(raw).length > 500) throw new Error("Evidence URLs cannot exceed 500 UTF-8 bytes");
    if (seen.has(raw)) throw new Error("Evidence URLs cannot contain duplicates");
    const authority = ipv4Parts ? hostname : hostname.split(".").slice(-2).join(".");
    if (authorities.has(authority)) throw new Error("Evidence URLs must use independent site authorities");
    seen.add(raw);
    authorities.add(authority);
  }
}

function assertDraftUint256(value: unknown, label: string, { allowZero = false } = {}) {
  if (typeof value !== "bigint" || value < 0n || value > UINT256_MAX || (!allowZero && value === 0n)) {
    throw new Error(`${label} must be an exact ${allowZero ? "non-negative" : "positive"} uint256 bigint`);
  }
  return value;
}

export async function assertBradburyWalletProvider(provider: PromiseBondWalletProvider, account?: Address) {
  const chainId = await provider.request({ method: "eth_chainId" });
  if (typeof chainId !== "string" || chainId.toLowerCase() !== BRADBURY_CHAIN_ID_HEX) {
    throw new Error("Wallet is not connected to GenLayer Bradbury (chain 4221)");
  }
  const code = await Promise.all(BRADBURY_CONSENSUS_CONTRACTS.map((address) => provider.request({
    method: "eth_getCode",
    params: [address, "latest"]
  })));
  if (code.some((value: unknown) => !hasRuntimeCode(value))) {
    throw new Error("Wallet RPC is not the pinned Bradbury network. Reconfigure chain 4221 to the Bradbury RPC.");
  }
  if (account) {
    const walletAccounts = await provider.request({ method: "eth_accounts" });
    const matches = Array.isArray(walletAccounts)
      && walletAccounts.some((value: unknown) => typeof value === "string" && value.toLowerCase() === account.toLowerCase());
    if (!matches) throw new Error("Connected wallet did not expose the selected PromiseBond account");
  }
}

/**
 * User-confirmed repair for wallets that still have chain 4221 bound to the GenLayer read RPC.
 * EIP-3085-capable wallets can add the official chain endpoint to the existing network; callers
 * should invoke this only from an explicit user action because the wallet may show a confirmation.
 */
export async function repairBradburyWalletRpc({
  account,
  provider
}: {
  account?: Address;
  provider: PromiseBondWalletProvider;
}) {
  try {
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        blockExplorerUrls: [promiseBondWalletChain.blockExplorers.default.url],
        chainId: BRADBURY_CHAIN_ID_HEX,
        chainName: promiseBondWalletChain.name,
        nativeCurrency: promiseBondWalletChain.nativeCurrency,
        rpcUrls: [BRADBURY_WALLET_RPC_URL]
      }]
    });
  } catch (error) {
    if (rpcErrorCode(error) === 4_001) throw error;
    throw new PromiseBondWalletRpcCompatibilityError(
      `Wallet could not add ${BRADBURY_WALLET_RPC_URL} to GenLayer chain 4221. `
      + `Open the wallet's network settings, add this RPC URL to chain 4221, select it as the default, then retry.`,
      { cause: error }
    );
  }
  await assertBradburyWalletProvider(provider, account);
  return { chainId: promiseBondWalletChain.id, rpcUrl: BRADBURY_WALLET_RPC_URL } as const;
}

async function assertExternallyOwnedWallet(
  provider: PromiseBondWalletProvider,
  address: Address,
  label: string
) {
  const code = await provider.request({
    method: "eth_getCode",
    params: [getAddress(address), "latest"]
  });
  if (code !== "0x") {
    throw new Error(`${label} must be an externally owned wallet with no deployed contract code`);
  }
}

function assertReviewedDraft(draft: PromiseBondDraft, creator: Address) {
  assertDraftUint256(draft.amountWei, "GEN amount");
  assertDraftUint256(draft.fundingDeadline, "Funding deadline");
  assertDraftUint256(draft.deadline, "Resolution deadline");
  const canonicalCreator = getAddress(creator);
  const canonicalBeneficiary = getAddress(draft.beneficiary);
  if (canonicalCreator === ZERO_ADDRESS || canonicalBeneficiary === ZERO_ADDRESS) {
    throw new Error("Creator and beneficiary must be nonzero wallet addresses");
  }
  if (canonicalBeneficiary === canonicalCreator) throw new Error("Beneficiary must differ from creator");
  if (draft.deadline <= draft.fundingDeadline) throw new Error("Resolution deadline must follow funding deadline");
  assertCanonicalText(draft.promise, "Promise");
  assertCanonicalText(draft.successCriteria, "Success criteria");
  assertCanonicalText(draft.failureCriteria, "Failure criteria");
  assertCanonicalEvidenceUrls(draft.evidenceUrls);
}

function assertDraft(draft: PromiseBondDraft, creator: Address) {
  assertReviewedDraft(draft, creator);
  const now = BigInt(Math.floor(Date.now() / 1_000));
  if (draft.fundingDeadline <= now) throw new Error("Funding deadline must be in the future");
}

function copyReviewedDraft(draft: PromiseBondDraft): PromiseBondDraft {
  return { ...draft, evidenceUrls: [...draft.evidenceUrls] };
}

function assertDeployedTerms(terms: PromiseBondTerms, draft: PromiseBondDraft, creator: Address) {
  if (terms.policy_version !== PROMISEBOND_POLICY_VERSION) throw new Error("Deployed contract policy does not match this app release");
  if (terms.creator !== getAddress(creator)) throw new Error("Deployed creator does not match the connected wallet");
  if (terms.beneficiary !== getAddress(draft.beneficiary)) throw new Error("Deployed beneficiary does not match the reviewed terms");
  if (terms.bond_amount_wei !== draft.amountWei) throw new Error("Deployed GEN amount does not match the reviewed terms");
  if (terms.funding_deadline !== draft.fundingDeadline || terms.deadline !== draft.deadline) {
    throw new Error("Deployed deadlines do not match the reviewed terms");
  }
  if (
    terms.promise_text !== draft.promise
    || terms.success_criteria !== draft.successCriteria
    || terms.failure_criteria !== draft.failureCriteria
    || terms.evidence_urls !== JSON.stringify(draft.evidenceUrls)
  ) {
    throw new Error("Deployed PromiseBond text or evidence sources do not match the reviewed terms");
  }
}

export function parseTestGenAmount(value: string) {
  const normalized = value.trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(normalized)) {
    throw new Error("Use a plain GEN amount with at most 18 decimal places");
  }
  const amount = parseUnits(normalized, 18);
  assertDraftUint256(amount, "GEN amount");
  return amount;
}

export function parseUtcDateTime(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    throw new Error(`${label} must include a UTC date and time`);
  }
  const iso = `${value}:00.000Z`;
  const milliseconds = Date.parse(iso);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is not a valid UTC date and time`);
  if (new Date(milliseconds).toISOString() !== iso) throw new Error(`${label} is not a valid UTC date and time`);
  return assertDraftUint256(BigInt(Math.floor(milliseconds / 1_000)), label);
}

async function readFinalPromiseBondWithClient(client: ReturnType<typeof createClient>, address: Address) {
  await assertBradburyReadClient(client);
  const common = {
    address: getAddress(address),
    args: [] as [],
    jsonSafeReturn: false,
    transactionHashVariant: TransactionHashVariant.LATEST_FINAL
  };
  const [termsValue, stateValue, balanceValue, contractCode] = await Promise.all([
    client.readContract({ ...common, functionName: "get_terms" }),
    client.readContract({ ...common, functionName: "get_state" }),
    client.readContract({ ...common, functionName: "get_contract_balance" }),
    client.getContractCode(common.address)
  ]);
  if (contractCode !== promiseBondSource) {
    throw new Error("Finalized contract source does not match the reviewed PromiseBond release");
  }
  const terms = asTerms(termsValue);
  const state = asState(stateValue);
  const contractBalanceWei = assertUnsignedBigInt(balanceValue, "contract balance");
  assertFinalizedStateInvariants(terms, state, contractBalanceWei);
  return { contractBalanceWei, state, terms };
}

export async function readFinalPromiseBond(address: Address) {
  return readFinalPromiseBondWithClient(createClient({ chain: promiseBondChain }), address);
}

export async function deployAndFundPromiseBond({
  account,
  draft,
  onDeployed,
  onDeploymentSubmitted,
  onFundingSubmitted,
  onProgress,
  provider
}: {
  account: Address;
  draft: PromiseBondDraft;
  onDeployed?: (deployment: PromiseBondDeployedContract) => void;
  onDeploymentSubmitted?: PromiseBondSubmittedCallback;
  onFundingSubmitted?: PromiseBondSubmittedCallback;
  onProgress?: (progress: PromiseBondProgress) => void;
  provider: PromiseBondWalletProvider;
}): Promise<PromiseBondDeployment> {
  const fundingAmountWei = draft.amountWei;
  const deployed = await deployPromiseBond({
    account,
    draft,
    onDeploymentSubmitted,
    onProgress,
    provider
  });
  onDeployed?.(deployed);
  const fundingTxId = await fundPromiseBond({
    account,
    amountWei: fundingAmountWei,
    contractAddress: deployed.contractAddress,
    onFundingSubmitted,
    onProgress,
    provider
  });
  onProgress?.("complete");
  return { ...deployed, fundingTxId };
}

async function verifyPromiseBondDeployment({
  account,
  deploymentTxId,
  draft
}: {
  account: Address;
  deploymentTxId: TransactionHash;
  draft: PromiseBondDraft;
}) {
  const creator = getAddress(account);
  assertReviewedDraft(draft, creator);
  const reviewedDraft = copyReviewedDraft(draft);
  const hash = transactionHash(deploymentTxId, "deployment");
  const client = createClient({ chain: promiseBondChain });
  const receipt = await waitForFinalizedTransaction(
    client,
    hash,
    "PromiseBond deployment",
    { kind: "deploy", sender: creator, source: promiseBondSource }
  );
  const contractAddress = normalizeAddress(receipt.recipient, "deployed contract");
  const snapshot = await readFinalPromiseBondWithClient(client, contractAddress);
  assertDeployedTerms(snapshot.terms, reviewedDraft, creator);
  return { contractAddress, deploymentTxId: hash, snapshot };
}

/** Reconciles a known deployment hash from finalized Bradbury state without broadcasting. */
export async function reconcilePromiseBondDeployment({
  account,
  deploymentTxId,
  draft
}: {
  account: Address;
  deploymentTxId: TransactionHash;
  draft: PromiseBondDraft;
}): Promise<PromiseBondDeployedContract> {
  const { contractAddress, deploymentTxId: finalizedTxId } = await verifyPromiseBondDeployment({
    account,
    deploymentTxId,
    draft
  });
  return { contractAddress, deploymentTxId: finalizedTxId };
}

export async function deployPromiseBond({
  account,
  draft,
  onDeploymentSubmitted,
  onProgress,
  provider
}: {
  account: Address;
  draft: PromiseBondDraft;
  onDeploymentSubmitted?: PromiseBondSubmittedCallback;
  onProgress?: (progress: PromiseBondProgress) => void;
  provider: PromiseBondWalletProvider;
}): Promise<PromiseBondDeployedContract> {
  const creator = getAddress(account);
  const beneficiary = getAddress(draft.beneficiary);
  assertDraft(draft, creator);
  const reviewedDraft = copyReviewedDraft(draft);
  await assertBradburyWalletProvider(provider, creator);
  await Promise.all([
    assertExternallyOwnedWallet(provider, creator, "Creator"),
    assertExternallyOwnedWallet(provider, beneficiary, "Beneficiary")
  ]);
  const client = clientFor(creator, provider);

  onProgress?.("awaiting_deployment_signature");
  const deploymentTxId = transactionHash(await client.deployContract({
    args: [
      calldataAddress(beneficiary),
      reviewedDraft.amountWei,
      reviewedDraft.fundingDeadline,
      reviewedDraft.deadline,
      reviewedDraft.promise,
      reviewedDraft.successCriteria,
      reviewedDraft.failureCriteria,
      JSON.stringify(reviewedDraft.evidenceUrls)
    ],
    code: new TextEncoder().encode(promiseBondSource),
    leaderOnly: false
  }), "deployment");
  await onDeploymentSubmitted?.(deploymentTxId);

  onProgress?.("deployment_finalizing");
  const { contractAddress, snapshot } = await verifyPromiseBondDeployment({
    account: creator,
    deploymentTxId,
    draft: reviewedDraft
  });
  if (snapshot.state.settlement !== "UNFUNDED" || snapshot.state.locked_amount_wei !== 0n) {
    throw new Error("New PromiseBond did not initialize in the expected unfunded state");
  }

  onProgress?.("deployment_finalized");
  return { contractAddress, deploymentTxId };
}

export async function fundPromiseBond({
  account,
  amountWei,
  contractAddress,
  onFundingSubmitted,
  onProgress,
  provider
}: {
  account: Address;
  amountWei: bigint;
  contractAddress: Address;
  onFundingSubmitted?: PromiseBondSubmittedCallback;
  onProgress?: (progress: PromiseBondProgress) => void;
  provider: PromiseBondWalletProvider;
}) {
  const creator = getAddress(account);
  const address = getAddress(contractAddress);
  assertDraftUint256(amountWei, "Funding GEN amount");
  await assertBradburyWalletProvider(provider, creator);
  const before = await readFinalPromiseBond(address);
  if (before.terms.creator !== creator || before.terms.bond_amount_wei !== amountWei) {
    throw new Error("Connected wallet or amount does not match the deployed PromiseBond terms");
  }
  if (before.state.settlement !== "UNFUNDED") {
    throw new Error("PromiseBond is no longer awaiting funding");
  }
  const client = clientFor(creator, provider);
  onProgress?.("awaiting_funding_signature");
  const fundingTxId = transactionHash(await client.writeContract({
    address,
    args: [],
    functionName: "fund",
    leaderOnly: false,
    value: amountWei
  }), "funding");
  await onFundingSubmitted?.(fundingTxId);

  onProgress?.("funding_finalizing");
  await reconcilePromiseBondFunding({
    account: creator,
    amountWei,
    contractAddress: address,
    fundingTxId
  });
  return fundingTxId;
}

/** Reconciles a known funding hash from finalized Bradbury state without broadcasting. */
export async function reconcilePromiseBondFunding({
  account,
  amountWei,
  contractAddress,
  fundingTxId
}: {
  account: Address;
  amountWei: bigint;
  contractAddress: Address;
  fundingTxId: TransactionHash;
}) {
  const creator = getAddress(account);
  const address = getAddress(contractAddress);
  assertDraftUint256(amountWei, "Funding GEN amount");
  const hash = transactionHash(fundingTxId, "funding");
  const client = createClient({ chain: promiseBondChain });
  await waitForFinalizedTransaction(
    client,
    hash,
    "PromiseBond funding",
    { address, kind: "call", method: "fund", sender: creator }
  );
  const snapshot = await readFinalPromiseBondWithClient(client, address);
  if (snapshot.terms.creator !== creator || snapshot.terms.bond_amount_wei !== amountWei) {
    throw new Error("Finalized funding does not match the PromiseBond creator or amount");
  }
  if (
    snapshot.state.funded_at === 0n
    || snapshot.state.settlement === "UNFUNDED"
    || snapshot.state.settlement === "EXPIRED"
  ) {
    throw new Error("PromiseBond funding finalized without evidence that principal was locked");
  }
  return { snapshot, transactionId: hash };
}

function assertActionPostcondition(
  functionName: "resolve" | "expire_unfunded" | "refund_unresolved" | "refund_stale",
  snapshot: Awaited<ReturnType<typeof readFinalPromiseBondWithClient>>
) {
  const { state, terms } = snapshot;
  if (functionName === "resolve") {
    const unresolved = state.outcome === "UNRESOLVED"
      && (state.settlement === "LOCKED" || state.settlement === "PAYOUT_QUEUED");
    const winner = (state.outcome === "FULFILLED" || state.outcome === "FAILED")
      && state.settlement === "PAYOUT_QUEUED";
    if (!unresolved && !winner) throw new Error("PromiseBond resolution finalized without the expected outcome");
    return;
  }
  if (functionName === "expire_unfunded") {
    if (state.settlement !== "EXPIRED") throw new Error("PromiseBond expiry finalized without the expected state");
    return;
  }
  if (functionName === "refund_unresolved") {
    if (state.settlement !== "PAYOUT_QUEUED" || state.outcome !== "UNRESOLVED") {
      throw new Error("Unresolved PromiseBond settlement did not queue the beneficiary payout");
    }
    return;
  }
  if (
    state.settlement !== "PAYOUT_QUEUED"
    || state.outcome !== "FAILED"
    || state.resolved_at < terms.deadline + STALE_REFUND_DELAY
  ) {
    throw new Error("Stale PromiseBond settlement did not fail closed to the beneficiary");
  }
}

/** Reconciles a known action hash from finalized Bradbury state without broadcasting. */
export async function reconcilePromiseBondAction({
  account,
  address,
  functionName,
  transactionId
}: {
  account: Address;
  address: Address;
  functionName: "resolve" | "expire_unfunded" | "refund_unresolved" | "refund_stale";
  transactionId: TransactionHash;
}) {
  const sender = getAddress(account);
  const contractAddress = getAddress(address);
  const hash = transactionHash(transactionId, functionName);
  const client = createClient({ chain: promiseBondChain });
  await waitForFinalizedTransaction(
    client,
    hash,
    `PromiseBond ${functionName}`,
    { address: contractAddress, kind: "call", method: functionName, sender }
  );
  const snapshot = await readFinalPromiseBondWithClient(client, contractAddress);
  assertActionPostcondition(functionName, snapshot);
  return { state: snapshot.state, transactionId: hash };
}

export async function submitPromiseBondAction({
  account,
  address,
  functionName,
  onSubmitted,
  provider
}: {
  account: Address;
  address: Address;
  functionName: "resolve" | "expire_unfunded" | "refund_unresolved" | "refund_stale";
  onSubmitted?: PromiseBondSubmittedCallback;
  provider: PromiseBondWalletProvider;
}) {
  const creator = getAddress(account);
  await assertBradburyWalletProvider(provider, creator);
  const client = clientFor(creator, provider);
  const hash = transactionHash(await client.writeContract({
    address: getAddress(address),
    args: [],
    functionName,
    leaderOnly: false,
    value: 0n
  }), functionName);
  await onSubmitted?.(hash);
  return reconcilePromiseBondAction({
    account: creator,
    address: getAddress(address),
    functionName,
    transactionId: hash
  });
}
