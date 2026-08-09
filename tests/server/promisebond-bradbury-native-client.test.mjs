import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { testnetBradbury } from "genlayer-js/chains";
import {
  ExecutionResult,
  TransactionHashVariant,
  TransactionStatus
} from "genlayer-js/types";
import { hexToBytes } from "viem";

import {
  GENLAYER_BRADBURY_IDENTITY,
  PROMISEBOND_BRADBURY_BROADCAST_AUTHORIZATION,
  PROMISEBOND_NATIVE_SOURCE_KECCAK256,
  assertFinalizedSuccessfulPromiseBondTransaction,
  broadcastPromiseBondWrite,
  buildPromiseBondWriteRequest,
  createPromiseBondBradburyReadClient,
  normalizeGenWei,
  readFinalizedPromiseBond,
  waitForFinalizedPromiseBondTransaction
} from "../../shared/promisebond/bradbury-native.js";

const CONTRACT = "0x1000000000000000000000000000000000000001";
const CREATOR = "0x2000000000000000000000000000000000000002";
const BENEFICIARY = "0x3000000000000000000000000000000000000003";
const TRANSACTION = `0x${"44".repeat(32)}`;
const BOND_AMOUNT = 1_250_000_000_000_000_000n;
const DEADLINE = 1_800_086_400n;
const UNRESOLVED_PAYOUT_DELAY = 7n * 24n * 60n * 60n;
const STALE_PAYOUT_DELAY = 30n * 24n * 60n * 60n;
const REVIEWED_SOURCE = fs.readFileSync("contracts/PromiseBond.py", "utf8");

function addressValue(address) {
  return { bytes: hexToBytes(address) };
}

function chainFixture(overrides = {}) {
  return {
    id: Number(GENLAYER_BRADBURY_IDENTITY.chainId),
    name: GENLAYER_BRADBURY_IDENTITY.chainName,
    nativeCurrency: {
      name: GENLAYER_BRADBURY_IDENTITY.nativeCurrencyName,
      symbol: GENLAYER_BRADBURY_IDENTITY.nativeCurrencySymbol,
      decimals: GENLAYER_BRADBURY_IDENTITY.nativeCurrencyDecimals
    },
    consensusMainContract: { address: GENLAYER_BRADBURY_IDENTITY.consensusMainAddress },
    consensusDataContract: { address: GENLAYER_BRADBURY_IDENTITY.consensusDataAddress },
    ...overrides
  };
}

function termsFixture(overrides = {}) {
  return new Map(Object.entries({
    policy_version: "promisebond.native-gen.v1",
    creator: addressValue(CREATOR),
    beneficiary: addressValue(BENEFICIARY),
    bond_amount_wei: BOND_AMOUNT,
    funding_deadline: 1_800_000_000n,
    deadline: DEADLINE,
    promise_text: "I will publish the audited release before the deadline.",
    success_criteria: "The approved release page must show the audited artifact.",
    failure_criteria: "The approved release page shows no qualifying artifact by the deadline.",
    evidence_urls: '["https://example.com/releases"]',
    ...overrides
  }));
}

function stateFixture(overrides = {}) {
  return new Map(Object.entries({
    settlement: "LOCKED",
    outcome: "NONE",
    bond_amount_wei: BOND_AMOUNT,
    locked_amount_wei: BOND_AMOUNT,
    funded_at: 1_799_900_000n,
    resolved_at: 0n,
    settlement_queued_at: 0n,
    payout_recipient: addressValue("0x0000000000000000000000000000000000000000"),
    reasoning: "",
    decisive_evidence: "",
    ...overrides
  }));
}

function receiptFixture(overrides = {}) {
  return {
    status: 7,
    statusName: TransactionStatus.FINALIZED,
    txExecutionResult: 1,
    txExecutionResultName: ExecutionResult.FINISHED_WITH_RETURN,
    result: 1,
    resultName: "AGREE",
    txId: TRANSACTION,
    hash: TRANSACTION,
    recipient: CONTRACT,
    sender: CREATOR,
    txDataDecoded: {
      type: "call",
      leaderOnly: false,
      callData: new Map([["method", "fund"]])
    },
    ...overrides
  };
}

function fakeClient({
  balance = BOND_AMOUNT,
  chain = chainFixture(),
  code = REVIEWED_SOURCE,
  receipt = receiptFixture(),
  state = stateFixture(),
  terms = termsFixture(),
  writeHash = TRANSACTION,
  withWriter = false
} = {}) {
  const calls = [];
  const client = {
    chain,
    async getChainId() {
      calls.push(["getChainId"]);
      return chain.id;
    },
    async getContractCode(address) {
      calls.push(["getContractCode", address]);
      return code;
    },
    async waitForTransactionReceipt(args) {
      calls.push(["waitForTransactionReceipt", args]);
      // Deliberately lossy. The implementation must use this only as a barrier.
      return { status_name: TransactionStatus.FINALIZED };
    },
    async getTransaction(args) {
      calls.push(["getTransaction", args]);
      return receipt;
    },
    async readContract(args) {
      calls.push(["readContract", args]);
      if (args.functionName === "get_terms") return terms;
      if (args.functionName === "get_state") return state;
      if (args.functionName === "get_contract_balance") return balance;
      throw new Error(`Unexpected function ${args.functionName}`);
    }
  };
  if (withWriter) {
    client.writeContract = async (args) => {
      calls.push(["writeContract", args]);
      return writeHash;
    };
  }
  return { calls, client };
}

test("read client is isolated, HTTPS-only, and exposes no broadcasting surface", () => {
  const originalEndpoints = [...testnetBradbury.rpcUrls.default.http];
  const client = createPromiseBondBradburyReadClient({
    rpcUrl: "https://bradbury.example.invalid/rpc"
  });

  assert.equal(client.chain.id, 4_221);
  assert.equal(client.writeContract, undefined);
  assert.equal(client.deployContract, undefined);
  assert.equal(client.connect, undefined);
  assert.deepEqual(testnetBradbury.rpcUrls.default.http, originalEndpoints);
  assert.notEqual(client.chain, testnetBradbury);
  assert.throws(
    () => createPromiseBondBradburyReadClient({ rpcUrl: "http://127.0.0.1:4000" }),
    /must use HTTPS/
  );
});

test("finalized reads preserve bigint values and normalize raw SDK address wrappers", async () => {
  const { calls, client } = fakeClient();
  const snapshot = await readFinalizedPromiseBond({ client, contractAddress: CONTRACT });

  assert.equal(snapshot.terms.creator, CREATOR);
  assert.equal(snapshot.terms.beneficiary, BENEFICIARY);
  assert.equal(snapshot.terms.bondAmountWei, BOND_AMOUNT);
  assert.equal(snapshot.state.lockedAmountWei, BOND_AMOUNT);
  assert.equal(snapshot.contractBalanceWei, BOND_AMOUNT);
  assert.equal(snapshot.readVariant, TransactionHashVariant.LATEST_FINAL);
  assert.deepEqual(calls.find(([name]) => name === "getContractCode"), ["getContractCode", CONTRACT]);

  const reads = calls.filter(([name]) => name === "readContract").map(([, args]) => args);
  assert.equal(reads.length, 3);
  for (const args of reads) {
    assert.equal(args.jsonSafeReturn, false);
    assert.equal(args.transactionHashVariant, TransactionHashVariant.LATEST_FINAL);
    assert.deepEqual(args.args, []);
  }
});

test("source identity is exact and fails before reads or broadcasts", async (t) => {
  assert.equal(
    PROMISEBOND_NATIVE_SOURCE_KECCAK256,
    "0xea739a4cc74438ffebb4656fd2ebc39d2a1df2239a6a9722ac227009c0488ea1"
  );

  await t.test("tampered source cannot be read as PromiseBond", async () => {
    const { calls, client } = fakeClient({ code: `${REVIEWED_SOURCE}\n# tampered` });
    await assert.rejects(
      readFinalizedPromiseBond({ client, contractAddress: CONTRACT }),
      /deployed PromiseBond source hash/
    );
    assert.equal(calls.some(([name]) => name === "readContract"), false);
  });

  await t.test("tampered source cannot receive a broadcast", async () => {
    const { calls, client } = fakeClient({ code: `${REVIEWED_SOURCE}\n# tampered`, withWriter: true });
    await assert.rejects(
      broadcastPromiseBondWrite({
        authorization: PROMISEBOND_BRADBURY_BROADCAST_AUTHORIZATION,
        contractAddress: CONTRACT,
        expectedSender: CREATOR,
        method: "fund",
        valueWei: BOND_AMOUNT,
        walletClient: client
      }),
      /deployed PromiseBond source hash/
    );
    assert.equal(calls.some(([name]) => name === "writeContract"), false);
  });

  await t.test("client without source retrieval fails closed", async () => {
    const { client } = fakeClient();
    delete client.getContractCode;
    await assert.rejects(
      readFinalizedPromiseBond({ client, contractAddress: CONTRACT }),
      /cannot verify deployed PromiseBond source code/
    );
  });
});

test("wrong live network and insolvent finalized state fail closed", async (t) => {
  await t.test("wrong chain", async () => {
    const { client } = fakeClient({ chain: chainFixture({ id: 1 }) });
    await assert.rejects(
      readFinalizedPromiseBond({ client, contractAddress: CONTRACT }),
      /Bradbury chain ID/
    );
  });

  await t.test("locked liability exceeds balance", async () => {
    const { client } = fakeClient({ balance: BOND_AMOUNT - 1n });
    await assert.rejects(
      readFinalizedPromiseBond({ client, contractAddress: CONTRACT }),
      /balance is below its locked liability/
    );
  });
});

test("fail-closed beneficiary payout states match the native contract", async (t) => {
  const unresolvedQueuedAt = DEADLINE + UNRESOLVED_PAYOUT_DELAY;
  const unresolvedState = stateFixture({
    settlement: "PAYOUT_QUEUED",
    outcome: "UNRESOLVED",
    locked_amount_wei: 0n,
    resolved_at: DEADLINE,
    settlement_queued_at: unresolvedQueuedAt,
    payout_recipient: addressValue(BENEFICIARY),
    reasoning: "Independent evidence was inconclusive.",
    decisive_evidence: "The unresolved payout delay elapsed."
  });

  await t.test("delayed unresolved payout to beneficiary is accepted", async () => {
    const { client } = fakeClient({ balance: 0n, state: unresolvedState });
    const snapshot = await readFinalizedPromiseBond({ client, contractAddress: CONTRACT });
    assert.equal(snapshot.state.settlement, "PAYOUT_QUEUED");
    assert.equal(snapshot.state.payoutRecipient, BENEFICIARY);
  });

  await t.test("early unresolved payout is rejected", async () => {
    const { client } = fakeClient({
      balance: 0n,
      state: stateFixture({
        ...Object.fromEntries(unresolvedState),
        settlement_queued_at: unresolvedQueuedAt - 1n
      })
    });
    await assert.rejects(
      readFinalizedPromiseBond({ client, contractAddress: CONTRACT }),
      /PAYOUT_QUEUED state/
    );
  });

  await t.test("retired REFUND_QUEUED state is rejected", async () => {
    const { client } = fakeClient({
      balance: 0n,
      state: stateFixture({
        ...Object.fromEntries(unresolvedState),
        settlement: "REFUND_QUEUED"
      })
    });
    await assert.rejects(
      readFinalizedPromiseBond({ client, contractAddress: CONTRACT }),
      /unknown settlement REFUND_QUEUED/
    );
  });
});

test("refund writes verify beneficiary payout postconditions", async (t) => {
  const receiptFor = (method) => receiptFixture({
    txDataDecoded: {
      type: "call",
      leaderOnly: false,
      callData: new Map([["method", method]])
    }
  });
  const payoutState = (overrides) => stateFixture({
    settlement: "PAYOUT_QUEUED",
    locked_amount_wei: 0n,
    payout_recipient: addressValue(BENEFICIARY),
    reasoning: "Fail-closed beneficiary settlement.",
    decisive_evidence: "The required settlement delay elapsed.",
    ...overrides
  });

  await t.test("refund_unresolved accepts delayed beneficiary payout", async () => {
    const { client } = fakeClient({
      balance: 0n,
      receipt: receiptFor("refund_unresolved"),
      state: payoutState({
        outcome: "UNRESOLVED",
        resolved_at: DEADLINE,
        settlement_queued_at: DEADLINE + UNRESOLVED_PAYOUT_DELAY
      }),
      withWriter: true
    });
    const result = await broadcastPromiseBondWrite({
      authorization: PROMISEBOND_BRADBURY_BROADCAST_AUTHORIZATION,
      contractAddress: CONTRACT,
      expectedSender: CREATOR,
      intervalMs: 0,
      method: "refund_unresolved",
      retries: 0,
      walletClient: client
    });
    assert.equal(result.snapshot.state.payoutRecipient, BENEFICIARY);
  });

  await t.test("refund_stale accepts delayed FAILED beneficiary payout", async () => {
    const staleAt = DEADLINE + STALE_PAYOUT_DELAY;
    const { client } = fakeClient({
      balance: 0n,
      receipt: receiptFor("refund_stale"),
      state: payoutState({
        outcome: "FAILED",
        resolved_at: staleAt,
        settlement_queued_at: staleAt
      }),
      withWriter: true
    });
    const result = await broadcastPromiseBondWrite({
      authorization: PROMISEBOND_BRADBURY_BROADCAST_AUTHORIZATION,
      contractAddress: CONTRACT,
      expectedSender: CREATOR,
      intervalMs: 0,
      method: "refund_stale",
      retries: 0,
      walletClient: client
    });
    assert.equal(result.snapshot.state.outcome, "FAILED");
    assert.equal(result.snapshot.state.payoutRecipient, BENEFICIARY);
  });

  await t.test("refund_stale rejects a payout before its dedicated delay", async () => {
    const { client } = fakeClient({
      balance: 0n,
      receipt: receiptFor("refund_stale"),
      state: payoutState({
        outcome: "FAILED",
        resolved_at: DEADLINE,
        settlement_queued_at: DEADLINE
      }),
      withWriter: true
    });
    await assert.rejects(
      broadcastPromiseBondWrite({
        authorization: PROMISEBOND_BRADBURY_BROADCAST_AUTHORIZATION,
        contractAddress: CONTRACT,
        expectedSender: CREATOR,
        intervalMs: 0,
        method: "refund_stale",
        retries: 0,
        walletClient: client
      }),
      /stale payout finalized before/
    );
  });
});

test("write requests use exact native GEN bigint and reject value on nonpayable methods", () => {
  assert.throws(() => normalizeGenWei(1), /never Number/);
  assert.throws(
    () => buildPromiseBondWriteRequest({ contractAddress: CONTRACT, method: "fund", valueWei: 1 }),
    /never Number/
  );

  const fund = buildPromiseBondWriteRequest({
    contractAddress: CONTRACT,
    method: "fund",
    valueWei: BOND_AMOUNT
  });
  assert.deepEqual(fund, {
    address: CONTRACT,
    functionName: "fund",
    args: [],
    value: BOND_AMOUNT,
    leaderOnly: false
  });
  assert.throws(
    () => buildPromiseBondWriteRequest({
      contractAddress: CONTRACT,
      method: "resolve",
      valueWei: 1n
    }),
    /must not attach GEN/
  );
  assert.equal(
    buildPromiseBondWriteRequest({ contractAddress: CONTRACT, method: "resolve" }).value,
    0n
  );
});

test("finality wait treats polling receipt as a barrier and validates the full transaction", async () => {
  const { calls, client } = fakeClient();
  const result = await waitForFinalizedPromiseBondTransaction({
    client,
    contractAddress: CONTRACT,
    expectedMethod: "fund",
    expectedNativeValueWei: BOND_AMOUNT,
    expectedSender: CREATOR,
    intervalMs: 0,
    retries: 0,
    transactionHash: TRANSACTION
  });

  assert.equal(result.hash, TRANSACTION);
  assert.equal(result.receiptValueObserved, false);
  const barrier = calls.find(([name]) => name === "waitForTransactionReceipt")[1];
  assert.equal(barrier.status, TransactionStatus.FINALIZED);
  assert.ok(calls.some(([name]) => name === "getTransaction"));
});

test("accepted, failed, and disagreeing transactions are never treated as successful", async (t) => {
  const cases = [
    ["accepted", { status: 5, statusName: TransactionStatus.ACCEPTED }],
    ["execution error", {
      txExecutionResult: 2,
      txExecutionResultName: ExecutionResult.FINISHED_WITH_ERROR
    }],
    ["no majority", { result: 5, resultName: "NO_MAJORITY" }],
    ["leader only", {
      txDataDecoded: {
        type: "call",
        leaderOnly: true,
        callData: new Map([["method", "fund"]])
      }
    }]
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => assertFinalizedSuccessfulPromiseBondTransaction({
          contractAddress: CONTRACT,
          expectedMethod: "fund",
          expectedNativeValueWei: BOND_AMOUNT,
          receipt: receiptFixture(overrides),
          transactionHash: TRANSACTION
        }),
        /PromiseBond Bradbury client rejected/
      );
    });
  }
});

test("broadcast is inert by default and explicit opt-in verifies finalized funding state", async () => {
  const disabled = fakeClient({ withWriter: true });
  await assert.rejects(
    broadcastPromiseBondWrite({
      contractAddress: CONTRACT,
      method: "fund",
      valueWei: BOND_AMOUNT,
      walletClient: disabled.client
    }),
    /broadcast is disabled/
  );
  assert.deepEqual(disabled.calls, []);

  const enabled = fakeClient({ withWriter: true });
  const result = await broadcastPromiseBondWrite({
    authorization: PROMISEBOND_BRADBURY_BROADCAST_AUTHORIZATION,
    contractAddress: CONTRACT,
    expectedSender: CREATOR,
    intervalMs: 0,
    method: "fund",
    retries: 0,
    valueWei: BOND_AMOUNT,
    walletClient: enabled.client
  });

  assert.equal(result.transactionHash, TRANSACTION);
  const write = enabled.calls.find(([name]) => name === "writeContract")[1];
  assert.equal(write.value, BOND_AMOUNT);
  assert.equal(write.functionName, "fund");
  assert.equal(write.leaderOnly, false);
  assert.equal(result.snapshot.state.settlement, "LOCKED");
});

const liveReadEnabled =
  process.env.PROMISEBOND_BRADBURY_READ_ONLY_TEST ===
  "I_UNDERSTAND_THIS_MAKES_A_BRADBURY_NETWORK_REQUEST";

test("optional Bradbury finalized-state read is explicitly environment-gated", {
  skip: liveReadEnabled ? false : "set the exact read-only opt-in value to contact Bradbury"
}, async () => {
  const contractAddress = process.env.PROMISEBOND_BRADBURY_CONTRACT_ADDRESS;
  assert.ok(contractAddress, "PROMISEBOND_BRADBURY_CONTRACT_ADDRESS is required");
  const client = createPromiseBondBradburyReadClient({
    rpcUrl: process.env.PROMISEBOND_BRADBURY_RPC_URL ?? GENLAYER_BRADBURY_IDENTITY.officialRpcUrl
  });
  const snapshot = await readFinalizedPromiseBond({ client, contractAddress });
  assert.equal(snapshot.terms.policyVersion, "promisebond.native-gen.v1");
});
