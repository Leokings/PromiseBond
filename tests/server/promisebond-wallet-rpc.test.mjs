import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const CHAIN_RPC = "https://rpc.testnet-chain.genlayer.com";
const GENLAYER_RPC = "https://rpc-bradbury.genlayer.com";

let server;
let promiseBond;
let providerConfig;

test.before(async () => {
  server = await createServer({
    appType: "custom",
    envDir: false,
    logLevel: "silent",
    server: { middlewareMode: true }
  });
  [promiseBond, providerConfig] = await Promise.all([
    server.ssrLoadModule("/src/features/promisebond/genlayer.ts"),
    server.ssrLoadModule("/src/providers/PromiseBondWalletProvider.tsx")
  ]);
});

test.after(async () => {
  await server?.close();
});

test("separates wallet EVM broadcast RPC from GenLayer read/finality RPC", () => {
  assert.deepEqual(providerConfig.promiseBondChain.rpcUrls.default.http, [CHAIN_RPC]);
  assert.deepEqual(providerConfig.promiseBondGenLayerChain.rpcUrls.default.http, [GENLAYER_RPC]);
  assert.equal(providerConfig.promiseBondChain.id, 4_221);
  assert.equal(providerConfig.promiseBondGenLayerChain.id, 4_221);
});

test("saved-hash reconciliation waits through Bradbury's appeal window and finalizer grace", () => {
  const observedAppealWindowMs = 30 * 60 * 1_000;
  const wait = promiseBond.PROMISEBOND_FINALITY_WAIT;

  assert.ok(Object.isFrozen(wait));
  assert.equal(wait.status, "FINALIZED");
  assert.equal(wait.interval, 3_000);
  assert.equal(wait.retries * wait.interval, 60 * 60 * 1_000);
  assert.ok(wait.retries * wait.interval > observedAppealWindowMs);
});

test("repair helper requests the official chain endpoint and revalidates wallet identity", async () => {
  const calls = [];
  const provider = {
    async request(args) {
      calls.push(args);
      if (args.method === "wallet_addEthereumChain") return null;
      if (args.method === "eth_chainId") return "0x107d";
      if (args.method === "eth_getCode") return "0x01";
      if (args.method === "eth_accounts") return [ACCOUNT];
      throw new Error(`Unexpected method ${args.method}`);
    }
  };

  const result = await promiseBond.repairBradburyWalletRpc({ account: ACCOUNT, provider });
  assert.deepEqual(result, { chainId: 4_221, rpcUrl: CHAIN_RPC });
  assert.deepEqual(calls[0], {
    method: "wallet_addEthereumChain",
    params: [{
      blockExplorerUrls: ["https://explorer-bradbury.genlayer.com/"],
      chainId: "0x107d",
      chainName: "Genlayer Bradbury Testnet",
      nativeCurrency: { decimals: 18, name: "GEN Token", symbol: "GEN" },
      rpcUrls: [CHAIN_RPC]
    }]
  });
  assert.ok(calls.some((call) => call.method === "eth_chainId"));
  assert.equal(calls.filter((call) => call.method === "eth_getCode").length, 2);
  assert.ok(calls.some((call) => call.method === "eth_accounts"));
});

test("repair failure is classified without implying a transaction was submitted", async () => {
  const rpcError = Object.assign(new Error("Method not supported"), { code: -32_601 });
  const provider = { request: async () => { throw rpcError; } };

  await assert.rejects(
    promiseBond.repairBradburyWalletRpc({ account: ACCOUNT, provider }),
    (error) => {
      assert.ok(promiseBond.isPromiseBondWalletRpcCompatibilityError(error));
      assert.equal(error.noTransactionHashReturned, true);
      assert.equal(error.repairRpcUrl, CHAIN_RPC);
      assert.equal(error.cause, rpcError);
      assert.match(error.message, /network settings/i);
      return true;
    }
  );
});

test("write-provider guard recognizes MetaMask's nested Bradbury string-ID failure", async () => {
  const rpcError = Object.assign(new Error("Internal JSON-RPC error."), {
    code: -32_603,
    data: {
      message: "json: cannot unmarshal string into Go struct field Request.id of type int"
    }
  });
  const provider = { request: async () => { throw rpcError; } };
  const guarded = promiseBond.withBradburyWalletRpcGuard(provider);

  await assert.rejects(
    guarded.request({ method: "eth_sendTransaction", params: [{}] }),
    (error) => {
      assert.ok(promiseBond.isPromiseBondWalletRpcCompatibilityError(error));
      assert.equal(error.noTransactionHashReturned, true);
      assert.equal(error.cause, rpcError);
      assert.match(error.message, new RegExp(CHAIN_RPC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    }
  );
});

test("write-provider guard preserves unrelated wallet failures", async () => {
  const rejection = Object.assign(new Error("User rejected transaction"), { code: 4_001 });
  const provider = { request: async () => { throw rejection; } };
  const guarded = promiseBond.withBradburyWalletRpcGuard(provider);

  await assert.rejects(
    guarded.request({ method: "eth_sendTransaction", params: [{}] }),
    (error) => {
      assert.equal(error, rejection);
      return true;
    }
  );
});

test("repair helper preserves explicit wallet rejection", async () => {
  const rejection = Object.assign(new Error("User rejected the request"), { code: 4_001 });
  const provider = { request: async () => { throw rejection; } };

  await assert.rejects(
    promiseBond.repairBradburyWalletRpc({ provider }),
    (error) => {
      assert.equal(error, rejection);
      assert.equal(promiseBond.isPromiseBondWalletRpcCompatibilityError(error), false);
      return true;
    }
  );
});
